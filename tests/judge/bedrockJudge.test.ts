/**
 * BedrockJudge — load-bearing fail-closed security test.
 *
 * Injects a throwing fake client via options.client. The fail-closed contract:
 *
 *  1. evaluate() ALWAYS resolves — it NEVER throws.
 *  2. The resolved value is ALWAYS failClosed: uncertain / confidence / 0 —
 *     NEVER 'accepted', NEVER 'rejected'.
 *  3. logger.warn is called exactly once per failed evaluate() call, with the
 *     error name only (no item content, no error message).
 *
 * This is the sentinel that prevents a broken/unreachable Bedrock endpoint
 * from silently auto-approving staged items (docs/04: LLM down → uncertain).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BedrockJudge } from '../../src/judge/bedrockJudge.js';
import { logger } from '../../src/observability/logger.js';
import type { BedrockInvoker } from '../../src/bedrock/client.js';
import type { JudgeItem } from '../../src/judge/judge.js';

const MODEL_ID = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

const STUB_ITEM: JudgeItem = {
  op: 'add',
  type: 'decision',
  title: 'Route all recall queries to a read-replica',
  summary: 'Offload primary write traffic by routing FTS queries to a read-replica.',
  body: 'Primary write traffic is high. Read-replicas allow independent scaling.',
  fields: {},
};

const FAIL_CLOSED = {
  verdict: 'uncertain',
  criterion: 'confidence',
  confidence: 0,
  reason: 'judge_unavailable',
  relatedMemoryId: null,
};

function makeThrowingClient(): BedrockInvoker {
  return {
    send: vi.fn().mockRejectedValue(new Error('upstream said: Route all recall queries')),
  };
}

function makeJudge() {
  return new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
}

describe('BedrockJudge — fail-closed when the client throws', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves uncertain/confidence/0 — NEVER throws — when the client rejects', async () => {
    await expect(makeJudge().evaluate(STUB_ITEM, [])).resolves.toEqual(FAIL_CLOSED);
  });

  it("resolved verdict is NEVER 'accepted'", async () => {
    const r = await makeJudge().evaluate(STUB_ITEM, []);
    expect(r.verdict).not.toBe('accepted');
  });

  it('calls logger.warn exactly once per failed evaluate() call', async () => {
    await makeJudge().evaluate(STUB_ITEM, []);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("logger.warn first arg identifies the fail-closed path ('uncertain')", async () => {
    await makeJudge().evaluate(STUB_ITEM, []);
    expect(warnSpy.mock.calls[0][0] as string).toContain('uncertain');
  });

  it('logs only the error name — no item content and no error message', async () => {
    await makeJudge().evaluate(STUB_ITEM, []);
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('Error');
    expect(logged).not.toContain('Route all recall queries');
    expect(logged).not.toContain('upstream said');
  });

  it('still resolves fail-closed on a second call (idempotent)', async () => {
    const judge = makeJudge();
    expect(await judge.evaluate(STUB_ITEM, [])).toEqual(FAIL_CLOSED);
    expect(await judge.evaluate(STUB_ITEM, [])).toEqual(FAIL_CLOSED);
  });
});
