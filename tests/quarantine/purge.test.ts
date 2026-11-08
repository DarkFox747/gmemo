import { describe, it, expect } from 'vitest';
import { purgeExpiredQuarantine } from '../../src/quarantine/purge.js';

describe('purgeExpiredQuarantine', () => {
  it('sums the per-project counts and keeps them in detail', async () => {
    const r = await purgeExpiredQuarantine({
      purgeExpired: () =>
        Promise.resolve([
          { projectId: 'p1', count: 2 },
          { projectId: 'p2', count: 1 },
        ]),
    });
    expect(r).toEqual({ job: 'quarantine-purge', count: 3, detail: { p1: 2, p2: 1 } });
  });

  it('empty → count 0 and empty detail', async () => {
    const r = await purgeExpiredQuarantine({ purgeExpired: () => Promise.resolve([]) });
    expect(r).toEqual({ job: 'quarantine-purge', count: 0, detail: {} });
  });
});
