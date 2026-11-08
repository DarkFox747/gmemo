/**
 * Architecture test (C5): the human-approved mode is reachable only from the
 * project_admin direct-management service. Source scan of src/**.ts.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const files = tsFiles(SRC).map((f) => ({
  path: relative(SRC, f).split(sep).join('/'),
  text: readFileSync(f, 'utf8'),
}));

const ALLOWED = new Set([
  'promote/promoteService.ts',
  'memory/directMemoryService.ts',
  'memory/types.ts',
]);

describe('humanApproved reachability', () => {
  it('scans a non-trivial source tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('humanApproved / HumanApproval appear only in the allowed files', () => {
    const offenders = files
      .filter((f) => /\bhumanApproved\b|\bHumanApproval\b/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !ALLOWED.has(p));
    expect(offenders).toEqual([]);
    expect(files.find((f) => f.path === 'memory/directMemoryService.ts')!.text).toMatch(
      /humanApproved/,
    );
  });

  it('no file under src/mcp imports the promote service', () => {
    const offenders = files
      .filter(
        (f) =>
          f.path.startsWith('mcp/') &&
          /from ['"][^'"]*promote\/promoteService(\.js)?['"]/.test(f.text),
      )
      // context.ts declares the AppServices bag type only (import type).
      .filter(
        (f) => !/import type \{[^}]*\} from ['"]\.\.\/promote\/promoteService\.js['"]/.test(f.text),
      );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('/promote never references promoteItem', () => {
    expect(files.find((f) => f.path === 'http/promote.ts')!.text).not.toMatch(/promoteItem/);
  });

  it('promote() hard-wires the automatic mode', () => {
    const svc = files.find((f) => f.path === 'promote/promoteService.ts')!.text;
    expect(svc).toMatch(/this\.processItem\(item, ctx, false\)/);
  });
});
