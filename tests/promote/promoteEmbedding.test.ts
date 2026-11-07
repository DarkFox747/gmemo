/**
 * T016: PromoteService embedding behaviour unit tests.
 *
 * DB-free: exercises the embed-before-applyAccepted path via a SpyEmbedder and
 * the shared fakes in ./fakes.ts.
 *
 * Covered cases:
 *  - accepted add / amend → embedder.embed called once with "title\nsummary\nbody";
 *                           returned vector forwarded to applyAccepted (non-null)
 *  - accepted supersede / deprecate → always mandatory review (C1, HU-06.4):
 *                           never applied here, so embed is NEVER called
 *  - PII-masked content is what gets embedded (raw PII never reaches the embedder)
 *  - embed throws → applyAccepted receives null; item still applied; no throw
 *                   escapes; no quarantine
 */

import { describe, it, expect } from 'vitest';
import type { Embedder } from '../../src/embedder/embedder.js';
import type { PromotionItemRow } from '../../src/db/promotionRepository.js';
import { makeItem as baseItem, makeService as baseService, META } from './fakes.js';

const SESSION_ID = 'sess-embed-001';

/** SpyEmbedder: records every embed() call; returns a fixed vector or throws. */
class SpyEmbedder implements Embedder {
  readonly embedCalls: string[] = [];

  constructor(private readonly behaviour: number[] | Error = [0.1, 0.2, 0.3]) {}

  embed(text: string): Promise<number[]> {
    this.embedCalls.push(text);
    if (this.behaviour instanceof Error) {
      return Promise.reject(this.behaviour);
    }
    return Promise.resolve(this.behaviour);
  }
}

function makeItem(id: string, overrides: Partial<Omit<PromotionItemRow, 'id'>> = {}) {
  return baseItem(id, {
    title: 'Embed title',
    summary: 'Embed summary.',
    body: 'Embed body referencing src/embedder/embedder.ts.',
    ...overrides,
  });
}

function makeService(items: PromotionItemRow[], embedder: Embedder) {
  return baseService(items, { embedder });
}

describe('PromoteService embedding — accepted add/amend', () => {
  for (const op of ['add', 'amend'] as const) {
    it(`accepted ${op} → embed called once with "title\\nsummary\\nbody"; vector passed to applyAccepted`, async () => {
      const vector = [0.1, 0.2, 0.3];
      const embedder = new SpyEmbedder(vector);
      const item = makeItem(`emb-${op}`, {
        op,
        title: 'My title',
        summary: 'My summary.',
        body: 'My body in src/x.ts.',
        target_memory_id: op !== 'add' ? 'mem-target-1' : null,
        target_revision: op !== 'add' ? 1 : null,
      });

      const { service, repo } = makeService([item], embedder);
      await service.promote(SESSION_ID, META);

      expect(embedder.embedCalls).toEqual(['My title\nMy summary.\nMy body in src/x.ts.']);
      expect(repo.applyAcceptedCalls).toHaveLength(1);
      expect(repo.applyAcceptedCalls[0]!.embedding).toEqual(vector);
    });
  }
});

describe('PromoteService embedding — supersede/deprecate are mandatory review', () => {
  for (const op of ['supersede', 'deprecate'] as const) {
    it(`accepted ${op} → queued for review; embed NEVER called; not applied`, async () => {
      const embedder = new SpyEmbedder([0.9, 0.8]);
      const item = makeItem(`emb-${op}`, { op, target_memory_id: 'mem-t', target_revision: 1 });

      const { service, repo } = makeService([item], embedder);
      const outcome = await service.promote(SESSION_ID, META);

      expect(embedder.embedCalls).toHaveLength(0);
      expect(repo.applyAcceptedCalls).toHaveLength(0);
      expect(outcome.uncertain).toBe(1);
    });
  }
});

describe('PromoteService embedding — masked content', () => {
  it('embeds the PII-masked text, never the raw email', async () => {
    const embedder = new SpyEmbedder();
    const item = makeItem('emb-pii', { summary: 'Ask jane.doe@example.com.' });

    const { service } = makeService([item], embedder);
    await service.promote(SESSION_ID, META);

    expect(embedder.embedCalls).toHaveLength(1);
    expect(embedder.embedCalls[0]).toContain('[EMAIL]');
    expect(embedder.embedCalls[0]).not.toContain('jane.doe@example.com');
  });
});

describe('PromoteService embedding — embed throws (fail-soft)', () => {
  it('embed throws → applyAccepted receives null; item still applied; no quarantine', async () => {
    const embedder = new SpyEmbedder(new Error('Bedrock unavailable'));
    const item = makeItem('emb-throw', { op: 'add' });

    const { service, repo } = makeService([item], embedder);
    const outcome = await service.promote(SESSION_ID, META);

    expect(embedder.embedCalls).toHaveLength(1);
    expect(repo.applyAcceptedCalls).toHaveLength(1);
    expect(repo.applyAcceptedCalls[0]!.embedding).toBeNull();
    expect(outcome).toMatchObject({ applied: 1, quarantined: 0, status: 'promoted' });
  });
});
