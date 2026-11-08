/**
 * Synthetic retrieval and judge metrics (C8, TT-06). Run: pnpm eval
 *
 * In-process and deterministic (no database, no network):
 *  - Recall: an in-memory BM25 ranking that approximates the Postgres FTS side
 *    (title/summary/body weighted like A/B/C) and a semantic ranking with the
 *    REAL StubEmbedder, fused with the REAL fuseRrf used by the recall tool.
 *    Metrics: recall@5, MRR, nDCG@5 over eval/fixtures/queries.json.
 *  - Judge: the REAL DeterministicJudge over eval/fixtures/judge.json, with the
 *    default confidence threshold (0.80). FP / FN rates as defined in
 *    scripts/lib/metrics.ts.
 *
 * Writes docs/demo/metricas.md (no timestamps, so two runs give identical files).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuseRrf, RRF_CANDIDATES } from '../src/search/rrf.js';
import { StubEmbedder } from '../src/embedder/stubEmbedder.js';
import { DeterministicJudge } from '../src/judge/deterministicJudge.js';
import type { JudgeContextItem, JudgeItem, JudgeResult } from '../src/judge/judge.js';
import {
  judgeErrorRates,
  mean,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  type Relevance,
} from './lib/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'eval', 'fixtures');
const OUTPUT = path.join(ROOT, 'docs', 'demo', 'metricas.md');

const K = 5;
/** Defaults of JUDGE_STUB_CONFIDENCE and JUDGE_CONFIDENCE_THRESHOLD (src/config). */
const STUB_CONFIDENCE = 0.9;
const CONFIDENCE_THRESHOLD = 0.8;
/** Postgres ts_rank default weights for A (title), B (summary), C (body). */
const FIELD_WEIGHTS = { title: 1.0, summary: 0.4, body: 0.2 } as const;

interface Unit {
  id: string;
  type: string;
  title: string;
  summary: string;
  body: string;
}
interface Query {
  id: string;
  query: string;
  relevant: Relevance;
}
interface JudgeFixtureCase {
  id: string;
  label: 'good' | 'bad';
  note: string;
  item: JudgeItem;
}

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// Lexical side: BM25 over weighted fields (an approximation of the FTS ranking)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a an and are as at be by can for from how in into is it of on or the to with where what when which'.split(
    ' ',
  ),
);

/** Lowercase words without stopwords, with a crude English suffix stemmer. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map((w) => {
      if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
      if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
      if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
      if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
      return w;
    });
}

function weightedTf(unit: Unit): Map<string, number> {
  const tf = new Map<string, number>();
  for (const field of ['title', 'summary', 'body'] as const) {
    for (const t of terms(unit[field])) tf.set(t, (tf.get(t) ?? 0) + FIELD_WEIGHTS[field]);
  }
  return tf;
}

function bm25Ranking(units: readonly Unit[], query: string): Unit[] {
  const k1 = 1.2;
  const b = 0.75;
  const docs = units.map((u) => ({ unit: u, tf: weightedTf(u) }));
  const lengths = docs.map((d) => [...d.tf.values()].reduce((a, v) => a + v, 0));
  const avgLength = mean(lengths);
  const qTerms = [...new Set(terms(query))];

  const scored = docs.map((d, i) => {
    let score = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t) ?? 0;
      if (f === 0) continue;
      const df = docs.filter((x) => x.tf.has(t)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * lengths[i]!) / avgLength)));
    }
    return { unit: d.unit, score };
  });

  // Like `content_tsv @@ query`: only matching units are candidates.
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score || x.unit.id.localeCompare(y.unit.id))
    .slice(0, RRF_CANDIDATES)
    .map((s) => s.unit);
}

// ---------------------------------------------------------------------------
// Semantic side: cosine over the stub embedder (deterministic, NOT semantic)
// ---------------------------------------------------------------------------

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // both vectors are L2-normalised by the embedder
}

async function semanticRanking(
  units: readonly Unit[],
  vectors: ReadonlyMap<string, number[]>,
  query: string,
  embedder: StubEmbedder,
): Promise<Unit[]> {
  const q = await embedder.embed(query);
  return units
    .map((u) => ({ unit: u, score: cosine(q, vectors.get(u.id)!) }))
    .sort((x, y) => y.score - x.score || x.unit.id.localeCompare(y.unit.id))
    .slice(0, RRF_CANDIDATES)
    .map((s) => s.unit);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmt = (n: number) => n.toFixed(3);
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

interface QueryScores {
  id: string;
  query: string;
  top: string[];
  recall: number;
  rr: number;
  ndcg: number;
}

function score(id: string, query: string, ranked: string[], rel: Relevance): QueryScores {
  return {
    id,
    query,
    top: ranked.slice(0, K),
    recall: recallAtK(ranked, rel, K),
    rr: reciprocalRank(ranked, rel),
    ndcg: ndcgAtK(ranked, rel, K),
  };
}

function aggregate(rows: readonly QueryScores[]): { recall: number; mrr: number; ndcg: number } {
  return {
    recall: mean(rows.map((r) => r.recall)),
    mrr: mean(rows.map((r) => r.rr)),
    ndcg: mean(rows.map((r) => r.ndcg)),
  };
}

async function main(): Promise<void> {
  const corpus = await readFixture<{ version: number; units: Unit[] }>('corpus.json');
  const queries = await readFixture<{ version: number; queries: Query[] }>('queries.json');
  const judgeFx = await readFixture<{
    version: number;
    context: JudgeContextItem[];
    cases: JudgeFixtureCase[];
  }>('judge.json');

  // Recall
  const embedder = new StubEmbedder();
  const vectors = new Map<string, number[]>();
  for (const u of corpus.units) {
    vectors.set(u.id, await embedder.embed(`${u.title}\n${u.summary}\n${u.body}`));
  }

  const hybrid: QueryScores[] = [];
  const lexicalOnly: QueryScores[] = [];
  for (const q of queries.queries) {
    const lexical = bm25Ranking(corpus.units, q.query);
    const semantic = await semanticRanking(corpus.units, vectors, q.query, embedder);
    const fused = fuseRrf(lexical, semantic).map((f) => f.row.id);
    hybrid.push(score(q.id, q.query, fused, q.relevant));
    lexicalOnly.push(
      score(
        q.id,
        q.query,
        lexical.map((u) => u.id),
        q.relevant,
      ),
    );
  }
  const h = aggregate(hybrid);
  const l = aggregate(lexicalOnly);

  // Judge
  const judge = new DeterministicJudge({ acceptedConfidence: STUB_CONFIDENCE });
  const judged: Array<JudgeFixtureCase & { result: JudgeResult; flagged: boolean }> = [];
  for (const c of judgeFx.cases) {
    const result = await judge.evaluate(c.item, judgeFx.context);
    const flagged = result.verdict !== 'accepted' || result.confidence < CONFIDENCE_THRESHOLD;
    judged.push({ ...c, result, flagged });
  }
  const rates = judgeErrorRates(judged);

  const lines: string[] = [
    '# Métricas sintéticas (TT-06)',
    '',
    '> **Aviso.** Estas cifras salen de **datos sintéticos** (`eval/fixtures/*.json`, versión ' +
      `${corpus.version}/${queries.version}/${judgeFx.version}) y de **stubs**: el juez es el ` +
      '`DeterministicJudge` (reglas, no un LLM) y el embedder es el `StubEmbedder` (vectores ' +
      'deterministas a partir de un hash, **sin semántica**). No miden la calidad de Bedrock ni ' +
      'de datos reales; sirven para fijar el método y detectar regresiones. Generado por ' +
      '`pnpm eval` (determinista: dos ejecuciones dan el mismo archivo).',
    '',
    '## Recuperación (recall)',
    '',
    `Corpus: ${corpus.units.length} unidades. Consultas: ${queries.queries.length} con relevancia ` +
      'graduada (2 = relevante, 1 = parcialmente relevante). k = 5.',
    '',
    '- **Léxico**: BM25 en memoria con pesos título/resumen/cuerpo = 1,0/0,4/0,2 (aproxima el ' +
      '`tsvector` A/B/C de Postgres; no es el motor real).',
    '- **Híbrido (RRF)**: el léxico fusionado con el ranking del `StubEmbedder` mediante la ' +
      'función real `fuseRrf` (k = 60), igual que la herramienta `recall`.',
    '',
    '| Método | recall@5 | MRR | nDCG@5 |',
    '|---|---|---|---|',
    `| Híbrido (RRF, embedder stub) | ${fmt(h.recall)} | ${fmt(h.mrr)} | ${fmt(h.ndcg)} |`,
    `| Solo léxico (referencia) | ${fmt(l.recall)} | ${fmt(l.mrr)} | ${fmt(l.ndcg)} |`,
    '',
    'Con el embedder stub el lado semántico es ruido determinista: la fusión puede subir una ' +
      'métrica (trae unidades sin palabras en común por azar) y bajar otra (desordena el top). ' +
      'Es el resultado esperado y honesto con stubs; con Titan v2 el lado semántico aportaría ' +
      'coincidencias por significado.',
    '',
    '### Detalle por consulta (híbrido)',
    '',
    '| Consulta | Top 5 | recall@5 | RR | nDCG@5 |',
    '|---|---|---|---|---|',
    ...hybrid.map(
      (r) =>
        `| ${r.id}: ${r.query} | ${r.top.join(', ')} | ${fmt(r.recall)} | ${fmt(r.rr)} | ${fmt(r.ndcg)} |`,
    ),
    '',
    '## Juez',
    '',
    `Casos: ${rates.good} buenos (deberían llegar a memoria) y ${rates.bad} malos (deberían ` +
      `retenerse). Umbral de confianza ${CONFIDENCE_THRESHOLD.toFixed(2)}; una unidad queda ` +
      '**retenida** si el veredicto no es `accepted` o la confianza está por debajo del umbral ' +
      '(va a cuarentena o a la cola humana). El contexto son las 4 memorias del fixture (en el ' +
      'pipeline real, las 3 primeras por FTS).',
    '',
    '- **Falsos positivos** = buenas retenidas / buenas: ' +
      `${rates.falsePositives}/${rates.good} = **${pct(rates.falsePositiveRate)}**`,
    '- **Falsos negativos** = malas que pasan / malas: ' +
      `${rates.falseNegatives}/${rates.bad} = **${pct(rates.falseNegativeRate)}**`,
    '',
    '| Caso | Etiqueta | Veredicto | Criterio | Confianza | Retenida | Nota |',
    '|---|---|---|---|---|---|---|',
    ...judged.map(
      (c) =>
        `| ${c.id} | ${c.label} | ${c.result.verdict} | ${c.result.criterion} | ` +
        `${c.result.confidence.toFixed(2)} | ${c.flagged ? 'sí' : 'no'} | ${c.note} |`,
    ),
    '',
    'Lectura: los falsos positivos cuestan tiempo de revisión (van a la cola, no se pierden); ' +
      'los falsos negativos son el riesgo real y por eso los tipos críticos (decision, ' +
      'constraint, domain_rule) pasan siempre por revisión obligatoria y las restauraciones de ' +
      'cuarentena se registran como etiquetas.',
    '',
  ];

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, lines.join('\n'), 'utf8');

  console.log(
    `Recall (hybrid RRF, stub embedder): recall@5=${fmt(h.recall)} MRR=${fmt(h.mrr)} nDCG@5=${fmt(h.ndcg)}`,
  );
  console.log(
    `Recall (lexical only):              recall@5=${fmt(l.recall)} MRR=${fmt(l.mrr)} nDCG@5=${fmt(l.ndcg)}`,
  );
  console.log(
    `Judge: FP rate=${fmt(rates.falsePositiveRate)} (${rates.falsePositives}/${rates.good}) ` +
      `FN rate=${fmt(rates.falseNegativeRate)} (${rates.falseNegatives}/${rates.bad})`,
  );
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`);
}

main().catch((err: unknown) => {
  console.error(`eval failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
