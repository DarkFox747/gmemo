/**
 * T017 (part 2) / T009 migration: BedrockJudge — load-bearing fail-closed security test.
 *
 * Migrated to the options-object constructor (T009): injects a throwing fake client
 * via options.client instead of relying on the deferred ENOTIMPLEMENTED throw.
 * The fail-closed security contract is PRESERVED and re-asserted:
 *
 *  1. evaluate() ALWAYS resolves — it NEVER throws, regardless of what
 *     the injected client does internally.
 *  2. The resolved value is ALWAYS 'uncertain' — NEVER 'accepted', NEVER 'rejected'.
 *  3. logger.warn is called exactly once per evaluate() call when invokeModel
 *     throws, so operators know the model is unreachable.
 *
 * This is the sentinel that prevents a broken/unreachable Bedrock endpoint
 * from silently auto-approving staged items.
 *
 * Design ref: docs/04-escritura-staging-promocion.md §"Judge seam" — Decision 5.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BedrockJudge } from '../../src/judge/bedrockJudge.js';
import { logger } from '../../src/observability/logger.js';
import type { BedrockInvoker } from '../../src/bedrock/client.js';
import type { JudgeItem } from '../../src/judge/judge.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MODEL_ID = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

/** Minimal JudgeItem — content is irrelevant for the fail-closed path. */
const STUB_ITEM: JudgeItem = {
  op: 'add',
  type: 'decision',
  title: 'Route all recall queries to a read-replica',
  summary: 'Offload primary write traffic by routing FTS queries to a read-replica.',
  body: 'Primary write traffic is high. Read-replicas allow independent scaling.',
  fields: {},
};

/**
 * Fake BedrockInvoker whose send() always rejects.
 * Injected via options.client to prove fail-closed without live AWS.
 */
function makeThrowingClient(): BedrockInvoker {
  return {
    send: vi.fn().mockRejectedValue(new Error('BedrockJudge.invokeModel not implemented (deferred)')),
  };
}

// ---------------------------------------------------------------------------
// Fail-closed contract
// ---------------------------------------------------------------------------

describe('BedrockJudge — fail-closed when invokeModel throws (injected throwing client)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves 'uncertain' — NEVER throws — when the client rejects", async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    // The injected client always rejects. evaluate() MUST resolve, not reject.
    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('uncertain');
  });

  it("resolved value is NEVER 'accepted'", async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    const verdict = await judge.evaluate(STUB_ITEM);
    expect(verdict).not.toBe('accepted');
  });

  it('does not throw — evaluate() is always a settled promise', async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    // rejects.toThrow would fail, confirming evaluate() never rejects
    let threw = false;
    try {
      await judge.evaluate(STUB_ITEM);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('calls logger.warn exactly once per failed evaluate() call', async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    await judge.evaluate(STUB_ITEM);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('logger.warn message contains "uncertain" to identify the fail-closed path', async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    await judge.evaluate(STUB_ITEM);
    const callsJson = JSON.stringify(warnSpy.mock.calls);
    expect(callsJson).toContain('uncertain');
  });

  it("calls logger.warn with the sentinel message from the source (first arg contains 'uncertain')", async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    await judge.evaluate(STUB_ITEM);
    // Assert called once and that the first argument identifies the fail-closed path.
    // Not asserting argument count so this test survives extra context args (e.g. the caught error).
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0] as string).toContain('uncertain');
  });

  it('still resolves uncertain on a second call (idempotent fail-closed)', async () => {
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: makeThrowingClient() });
    const first = await judge.evaluate(STUB_ITEM);
    const second = await judge.evaluate(STUB_ITEM);
    expect(first).toBe('uncertain');
    expect(second).toBe('uncertain');
  });
});
