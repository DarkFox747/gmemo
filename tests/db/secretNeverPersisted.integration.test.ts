/**
 * Secret never persisted (C3, HU-10): staged items carrying secrets go through
 * the real promotion pipeline and a restore is then attempted (refused: redacted
 * rows are not restorable, SEC-L3); afterwards EVERY
 * text/varchar/json/jsonb/text[] column of EVERY public table is scanned for
 * each secret fragment and must return 0 rows. Also asserts the surrounding
 * non-secret text survived (span redaction, not a whole-field false pass).
 *
 * Sentinels are unique to this suite so fixtures of other suites sharing the
 * database cannot cause false hits. Identifiers are quoted; values are bind
 * parameters (strpos: an exact substring test, no LIKE wildcards).
 * SKIPPED without DATABASE_URL.
 */

import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { ProjectMember } from '../../src/mcp/context.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SLUG = 'secret-never-persisted';
const REPO_URL = 'https://github.com/test/secret-never-persisted';
const SESSION = '01J0SECRETNEVERPERSIST0000';
const TL = 'snp-tl-sub';

const AWS_KEY = 'AKIANEVRPRSTD7Q3K9W2';
const FIELD_KEY_SECRET = 'ASIAZZNEVERST0RED9X1';
const PEM_BODY = 'MIIEpNeverPersistedPemBodyLineQ7';
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;
const API_VALUE = 'Zx9Qw2Er4Ty6Ui8Op0As1Df3';
const SLACK_BODY = 'NeverPersistSlackBody77';
const SLACK = `xoxb-4242-${SLACK_BODY}`;
const R2_SECRET = 'hunter2hunter2';
// SEC-M1: PEM header in the title, key body in the body (no pattern on the body alone).
const CROSS_PEM_BODY = 'MIIEpCrossFieldNeverStoredQ8';

const FRAGMENTS = [
  AWS_KEY,
  'NEVRPRSTD7Q3K9W2',
  FIELD_KEY_SECRET,
  'ZZNEVERST0RED9X1',
  PEM_BODY,
  API_VALUE,
  'Er4Ty6Ui8Op0',
  SLACK,
  SLACK_BODY,
  R2_SECRET,
  'hunter2',
  CROSS_PEM_BODY,
  'CrossFieldNeverStored',
];

describeWithDb('secret never persisted (all tables)', () => {
  let pool: pg.Pool;
  let projectId: string;
  let repoId: string;
  let tlUserId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations(DATABASE_URL!);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    projectId = (
      await pool.query(
        `INSERT INTO project (slug, name) VALUES ($1, 'SNP') ON CONFLICT (slug) DO UPDATE SET name = 'SNP' RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;
    repoId = (
      await pool.query(
        `INSERT INTO repo (project_id, remote_url) VALUES ($1, $2)
         ON CONFLICT (remote_url) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING id`,
        [projectId, REPO_URL],
      )
    ).rows[0].id;
    tlUserId = (
      await pool.query(
        `INSERT INTO app_user (idp_subject, email) VALUES ($1, 'snp-tl@x.io')
         ON CONFLICT (idp_subject) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [TL],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO staging_session (id, project_id, repo_id, branch, opened_by, pr_number)
       VALUES ($1, $2, $3, 'feat/leaky', 'snp-author', 9) ON CONFLICT DO NOTHING`,
      [SESSION, projectId, repoId],
    );

    const insert = (
      title: string,
      summary: string,
      body: string,
      fields: Record<string, unknown>,
      hash: string,
    ) =>
      pool.query(
        `INSERT INTO staging_item (session_id, op, type, title, summary, body, fields, content_hash, author_identity)
         VALUES ($1, 'add', 'pattern', $2, $3, $4, $5::jsonb, $6, 'snp-author')`,
        [SESSION, title, summary, body, JSON.stringify(fields), hash],
      );
    // A: span-redactable secrets in summary, body and a fields leaf.
    await insert(
      'Deploy pipeline credential rotation',
      `Rotation notes for ${SLACK} signing.`,
      `Deploy failed when ${AWS_KEY} expired in src/deploy.ts. Set api_key=${API_VALUE} and notify ${SLACK} after rotating.`,
      { note: `old key ${AWS_KEY}` },
      'snp-hash-a',
    );
    // B: a secret used as a fields KEY → whole redaction.
    await insert(
      'Fields key leak in deploy config',
      'Config map keyed by credential.',
      'The config map in src/config.ts is keyed by the credential itself.',
      { [FIELD_KEY_SECRET]: 'value' },
      'snp-hash-b',
    );
    // C: natural-language disclosure the detectors miss → judge R2 (whole).
    await insert(
      'Staging database access for migrations',
      'How to reach the staging database.',
      `The staging password is ${R2_SECRET} for the migrate job in scripts/migrate.ts.`,
      {},
      'snp-hash-c',
    );
    // D: PEM split across fields (SEC-M1) → whole redaction, no key body left anywhere.
    await insert(
      '-----BEGIN RSA PRIVATE KEY----- cross-field rotation',
      'Signing key used by the deploy job.',
      `${CROSS_PEM_BODY}
-----END RSA PRIVATE KEY-----`,
      {},
      'snp-hash-d',
    );
    // E: a full PEM block in one field → whole redaction too.
    await insert(
      'Signing key rotation for releases',
      'Key kept inline by mistake.',
      `Use this key:
${PEM}
for release signing in scripts/release.ts.`,
      {},
      'snp-hash-e',
    );

    const { PgAuthRepository } = await import('../../src/db/authRepository.js');
    const { PgPromotionRepository } = await import('../../src/db/promotionRepository.js');
    const { PgQuarantineRepository } = await import('../../src/db/quarantineRepository.js');
    const { RdsAuditLogger } = await import('../../src/auth/auditLogger.js');
    const { DeterministicJudge } = await import('../../src/judge/deterministicJudge.js');
    const { PromoteService } = await import('../../src/promote/promoteService.js');
    const { QuarantineService } = await import('../../src/quarantine/quarantineService.js');
    const { logNotifier } = await import('../../src/notify/notifier.js');
    const { StubEmbedder } = await import('../../src/embedder/stubEmbedder.js');

    const promotionRepository = new PgPromotionRepository(pool, { quarantineRetentionDays: 60, revalidationDays: 60 });
    const promoteService = new PromoteService({
      promotionRepository,
      judge: new DeterministicJudge({ acceptedConfidence: 0.9 }),
      auditLogger: new RdsAuditLogger(new PgAuthRepository(pool)),
      embedder: new StubEmbedder(),
      notifier: logNotifier,
      routing: { confidenceThreshold: 0.8, mandatoryReviewTypes: new Set(['decision']) },
    });
    const outcome = await promoteService.promote(SESSION, {
      tenant: { projectId, repoId, branch: 'feat/leaky' },
      actor: { actorId: 'test/snp', userId: null, roles: ['service_agent'] },
      originBranch: 'feat/leaky',
      originPr: 9,
      mergeSha: null,
    });
    expect(outcome.quarantined).toBe(5);

    // Try to restore every row: all are redacted (secret_detected) → refused (SEC-L3).
    const quarantineService = new QuarantineService({
      quarantineRepository: new PgQuarantineRepository(pool),
      promoteService,
    });
    const member: ProjectMember = {
      actorId: TL,
      userId: tlUserId,
      roles: ['project_admin'],
      projectRole: 'project_admin',
    };
    const { rows } = await pool.query(`SELECT id FROM quarantine WHERE project_id = $1`, [
      projectId,
    ]);
    for (const r of rows) {
      const res = await quarantineService.restore(member, projectId, r.id);
      expect(res.kind).toBe('not_found');
    }
  });

  afterAll(async () => {
    if (!pool) return;
    vi.restoreAllMocks();
    await pool.query(`DELETE FROM quarantine WHERE project_id = $1`, [projectId]);
    await pool.query(
      `DELETE FROM memory_revision WHERE memory_id IN (SELECT id FROM memory WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(
      `DELETE FROM staging_item WHERE session_id IN (SELECT id FROM staging_session WHERE project_id = $1)`,
      [projectId],
    );
    await pool.query(`DELETE FROM access_log WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM project WHERE slug = $1`, [SLUG]);
    await pool.query(`DELETE FROM app_user WHERE idp_subject = $1`, [TL]);
    await pool.end();
  });

  it('no secret fragment appears in any text/json column of any table', async () => {
    const { rows: cols } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'
          AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR c.udt_name = '_text')`,
    );
    const tables = new Set(cols.map((c) => c.table_name));
    for (const t of ['quarantine', 'staging_item', 'memory', 'memory_revision', 'access_log']) {
      expect(tables.has(t)).toBe(true);
    }

    const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
    const hits: string[] = [];
    for (const { table_name, column_name } of cols) {
      for (const fragment of FRAGMENTS) {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${quote(table_name)} WHERE strpos(${quote(column_name)}::text, $1) > 0`,
          [fragment],
        );
        if (rows[0]!.n > 0) hits.push(`${table_name}.${column_name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the surrounding text survived on the span-redacted row', async () => {
    const { rows } = await pool.query(
      `SELECT summary, body, fields, criterion, reason_code, restored_at FROM quarantine
        WHERE project_id = $1 AND title = 'Deploy pipeline credential rotation' AND reason_code = 'secret_detected'`,
      [projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(
      'Deploy failed when [REDACTADO] expired in src/deploy.ts. Set api_key=[REDACTADO] and notify [REDACTADO] after rotating.',
    );
    expect(rows[0].summary).toBe('Rotation notes for [REDACTADO] signing.');
    expect(rows[0].fields).toEqual({ note: 'old key [REDACTADO]' });
    expect(rows[0]).toMatchObject({ criterion: 'pipeline' });
    expect(rows[0].restored_at).toBeNull();
  });

  it('the key-in-fields, both PEM and the R2 rows are whole-redacted', async () => {
    const { rows } = await pool.query(
      `SELECT title, summary, body, fields, judge_reason, criterion, reason_code FROM quarantine
        WHERE project_id = $1 AND restored_at IS NULL AND body = '[REDACTADO]' ORDER BY judge_reason`,
      [projectId],
    );
    expect(rows.map((r) => [r.judge_reason, r.criterion, r.reason_code])).toEqual([
      ['secret_detected', 'pipeline', 'secret_detected'],
      ['secret_detected', 'pipeline', 'secret_detected'],
      ['secret_detected', 'pipeline', 'secret_detected'],
      ['security_second_layer', 'judge', 'secret_detected'],
    ]);
    for (const r of rows) {
      expect(r.fields).toEqual({});
      expect([r.title, r.summary]).toEqual(['[REDACTADO]', '[REDACTADO]']);
    }
  });

  it('SEC-M2: redacted staging rows no longer carry their original content_hash', async () => {
    const { rows } = await pool.query(
      `SELECT si.content_hash FROM staging_item si
         JOIN staging_session ss ON ss.id = si.session_id
        WHERE ss.id = $1`,
      [SESSION],
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.content_hash).not.toMatch(/^snp-hash-/);
  });
});
