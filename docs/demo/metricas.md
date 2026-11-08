# Métricas sintéticas (TT-06)

> **Aviso.** Estas cifras salen de **datos sintéticos** (`eval/fixtures/*.json`, versión 1/1/1) y de **stubs**: el juez es el `DeterministicJudge` (reglas, no un LLM) y el embedder es el `StubEmbedder` (vectores deterministas a partir de un hash, **sin semántica**). No miden la calidad de Bedrock ni de datos reales; sirven para fijar el método y detectar regresiones. Generado por `pnpm eval` (determinista: dos ejecuciones dan el mismo archivo).

## Recuperación (recall)

Corpus: 20 unidades. Consultas: 15 con relevancia graduada (2 = relevante, 1 = parcialmente relevante). k = 5.

- **Léxico**: BM25 en memoria con pesos título/resumen/cuerpo = 1,0/0,4/0,2 (aproxima el `tsvector` A/B/C de Postgres; no es el motor real).
- **Híbrido (RRF)**: el léxico fusionado con el ranking del `StubEmbedder` mediante la función real `fuseRrf` (k = 60), igual que la herramienta `recall`.

| Método | recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| Híbrido (RRF, embedder stub) | 0.911 | 0.694 | 0.695 |
| Solo léxico (referencia) | 0.878 | 1.000 | 0.954 |

Con el embedder stub el lado semántico es ruido determinista: la fusión puede subir una métrica (trae unidades sin palabras en común por azar) y bajar otra (desordena el top). Es el resultado esperado y honesto con stubs; con Titan v2 el lado semántico aportaría coincidencias por significado.

### Detalle por consulta (híbrido)

| Consulta | Top 5 | recall@5 | RR | nDCG@5 |
|---|---|---|---|---|
| q01: how are customer notifications sent | c18, c01, c03, c20, c13 | 0.667 | 1.000 | 0.700 |
| q02: profile cache TTL redis | c10, c02, c19, c12, c03 | 1.000 | 0.500 | 0.659 |
| q03: where can personal data be stored region | c16, c03, c08, c10, c04 | 1.000 | 0.500 | 0.631 |
| q04: invoice pdf timeout | c18, c04, c10, c11, c17 | 0.500 | 0.500 | 0.521 |
| q05: retry third-party http calls | c03, c17, c14, c05, c01 | 0.500 | 0.250 | 0.356 |
| q06: pagination cursor for list endpoints | c20, c06, c18, c01, c09 | 1.000 | 0.500 | 0.631 |
| q07: declined card payment gateway sandbox | c04, c16, c07, c15, c12 | 1.000 | 0.500 | 0.587 |
| q08: email rate limit bulk campaign | c14, c18, c13, c08, c15 | 1.000 | 1.000 | 0.631 |
| q09: refund approval rules | c16, c09, c13, c18, c02 | 1.000 | 1.000 | 0.797 |
| q10: login latency improvement | c10, c17, c20, c06, c03 | 1.000 | 1.000 | 1.000 |
| q11: billing job runs twice cron timezone | c04, c14, c11, c08, c19 | 1.000 | 0.333 | 0.500 |
| q12: hide internal flags from public responses | c12, c08, c05, c09, c19 | 1.000 | 1.000 | 1.000 |
| q13: change account email verification | c08, c11, c13, c18, c12 | 1.000 | 0.333 | 0.500 |
| q14: outbox worker acknowledge | c14, c18, c01, c03, c09 | 1.000 | 1.000 | 0.964 |
| q15: upload customer documents encryption | c15, c20, c01, c03, c02 | 1.000 | 1.000 | 0.945 |

## Juez

Casos: 10 buenos (deberían llegar a memoria) y 10 malos (deberían retenerse). Umbral de confianza 0.80; una unidad queda **retenida** si el veredicto no es `accepted` o la confianza está por debajo del umbral (va a cuarentena o a la cola humana). El contexto son las 4 memorias del fixture (en el pipeline real, las 3 primeras por FTS).

- **Falsos positivos** = buenas retenidas / buenas: 3/10 = **30.0 %**
- **Falsos negativos** = malas que pasan / malas: 2/10 = **20.0 %**

| Caso | Etiqueta | Veredicto | Criterio | Confianza | Retenida | Nota |
|---|---|---|---|---|---|---|
| g01 | good | accepted | confidence | 0.90 | no | grounded gotcha |
| g02 | good | accepted | confidence | 0.90 | no | new decision, unrelated title |
| g03 | good | accepted | confidence | 0.90 | no | pattern |
| g04 | good | accepted | confidence | 0.90 | no | domain rule |
| g05 | good | accepted | confidence | 0.90 | no | constraint |
| g06 | good | accepted | confidence | 0.90 | no | outcome |
| g07 | good | accepted | confidence | 0.90 | no | integration note with a URL |
| g08 | good | uncertain | grounding | 0.60 | sí | true gotcha described without a concrete artefact (grounding false positive) |
| g09 | good | uncertain | contradiction | 0.70 | sí | legitimate refinement of an existing decision (contradiction false positive) |
| g10 | good | accepted | confidence | 0.60 | sí | correct pattern whose body uses the word 'might' (hedge false positive) |
| b01 | bad | rejected | security_second_layer | 0.95 | sí | credential disclosed in natural language (placeholder value) |
| b02 | bad | rejected | specificity | 0.90 | sí | generic title |
| b03 | bad | rejected | specificity | 0.90 | sí | too short to be actionable |
| b04 | bad | rejected | duplication | 0.95 | sí | restates an existing memory |
| b05 | bad | uncertain | contradiction | 0.70 | sí | contradicts an active decision without superseding it |
| b06 | bad | uncertain | grounding | 0.60 | sí | vague gotcha without evidence |
| b07 | bad | rejected | security_second_layer | 0.95 | sí | encoded blob (harmless text, flagged by the second security layer) |
| b08 | bad | accepted | confidence | 0.90 | no | harmful advice that is well-formed and grounded (judge false negative) |
| b09 | bad | accepted | confidence | 0.90 | no | paraphrased duplicate of the refund rule (judge false negative) |
| b10 | bad | accepted | confidence | 0.60 | sí | speculation stated as a gotcha |

Lectura: los falsos positivos cuestan tiempo de revisión (van a la cola, no se pierden); los falsos negativos son el riesgo real y por eso los tipos críticos (decision, constraint, domain_rule) pasan siempre por revisión obligatoria y las restauraciones de cuarentena se registran como etiquetas.
