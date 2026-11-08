/**
 * The C3 "secret never persisted" scan, shared by the DB-gated suites: every
 * text / varchar / json / jsonb / text[] column of every public BASE TABLE is
 * searched for each fragment. Identifiers are quoted; values are bind
 * parameters (strpos: an exact substring test, no LIKE wildcards).
 * Returns the `table.column` hits (expected: []).
 */

import type pg from 'pg';

export async function scanTextColumnsForFragments(
  pool: pg.Pool,
  fragments: readonly string[],
): Promise<{ tables: Set<string>; hits: string[] }> {
  const { rows: cols } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR c.udt_name = '_text')`,
  );
  const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
  const hits: string[] = [];
  for (const { table_name, column_name } of cols) {
    for (const fragment of fragments) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${quote(table_name)} WHERE strpos(${quote(column_name)}::text, $1) > 0`,
        [fragment],
      );
      if (rows[0]!.n > 0) hits.push(`${table_name}.${column_name}`);
    }
  }
  return { tables: new Set(cols.map((c) => c.table_name)), hits };
}
