/**
 * XSS guard (C1 R1-SEC8): server text is rendered as React text only.
 * Scans the web sources for HTML sinks and for lint suppressions of the rule
 * that forbids them, and proves the ESLint rule itself fires.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SRC, '..', '..', '..');
const SELF = fileURLToPath(import.meta.url);

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(e.name) && full !== SELF ? [full] : [];
  });
}

// Built from parts so this file never matches its own patterns.
const SINKS = [
  'dangerously' + 'SetInnerHTML',
  'inner' + 'HTML',
  'outer' + 'HTML',
  'insertAdjacent' + 'HTML',
];

describe('web XSS guard', () => {
  it('no HTML sinks or no-restricted-syntax suppressions in packages/web/src', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const s of SINKS) if (text.includes(s)) offenders.push(`${path.basename(f)}: ${s}`);
      if (/eslint-disable[^\n]*no-restricted-syntax/.test(text)) {
        offenders.push(`${path.basename(f)}: lint suppression`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ESLint rejects a dangerouslySetInnerHTML snippet under packages/web/src', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const attr = 'dangerously' + 'SetInnerHTML';
    const code = `export const X = () => <div ${attr}={{ __html: 'x' }} />;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'packages', 'web', 'src', 'fixture.tsx'),
    });
    const ids = result!.messages.map((m) => m.ruleId);
    expect(ids).toContain('no-restricted-syntax');
  });
});
