/**
 * T008: BedrockJudge.invokeModel — injected fake client (no live AWS).
 *
 * Uses the injection seam (options.client) to pass a { send: vi.fn() } fake.
 * ConverseCommand responses are crafted inline; no vi.mock of the SDK needed.
 *
 * Coverage:
 *  - Happy path ×3: accepted / rejected / uncertain replies map correctly.
 *    Assert the sent ConverseCommand has the expected modelId, system block,
 *    and exactly one user message.
 *  - Unmapped reply ("maybe?") → uncertain.
 *  - Empty reply ("") → uncertain.
 *  - AWS error (send rejects) → evaluate() resolves uncertain (fail-closed).
 *  - Fail-closed invariant: never resolves 'accepted' when send rejects.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockJudge, parseVerdict } from '../../src/judge/bedrockJudge.js';
import type { JudgeItem } from '../../src/judge/judge.js';

const MODEL_ID = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';

/** Minimal JudgeItem fixture — content is irrelevant for these seam tests. */
const STUB_ITEM: JudgeItem = {
  op: 'add',
  type: 'decision',
  title: 'Route all recall queries to a read-replica',
  summary: 'Offload primary write traffic by routing FTS queries to a read-replica.',
  body: 'Primary write traffic is high. Read-replicas allow independent scaling.',
  fields: {},
};

/** Builds a minimal Converse API response with the given assistant text. */
function makeConverseResponse(text: string) {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ text }],
      },
    },
    stopReason: 'end_turn',
  };
}

describe('BedrockJudge.invokeModel — injected fake (no real AWS)', () => {
  // ── Happy path: verdict mapping ─────────────────────────────────────────────

  it("resolves 'accepted' when model replies 'accepted'", async () => {
    const send = vi.fn().mockResolvedValue(makeConverseResponse('accepted'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('accepted');
  });

  it("resolves 'rejected' when model replies 'rejected'", async () => {
    const send = vi.fn().mockResolvedValue(makeConverseResponse('rejected'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('rejected');
  });

  it("resolves 'uncertain' when model replies 'uncertain'", async () => {
    const send = vi.fn().mockResolvedValue(makeConverseResponse('uncertain'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('uncertain');
  });

  // ── Command shape assertion ──────────────────────────────────────────────────

  it('sends a ConverseCommand with the expected modelId, system block, and one user message', async () => {
    const send = vi.fn().mockResolvedValue(makeConverseResponse('accepted'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    await judge.evaluate(STUB_ITEM);

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0][0] as ConverseCommand;
    expect(command).toBeInstanceOf(ConverseCommand);
    expect(command.input.modelId).toBe(MODEL_ID);
    expect(Array.isArray(command.input.system)).toBe(true);
    expect((command.input.system as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(command.input.messages)).toBe(true);
    expect(command.input.messages).toHaveLength(1);
    expect(command.input.messages![0].role).toBe('user');
  });

  // ── Fail-closed: unmapped / empty replies → uncertain ───────────────────────

  it("resolves 'uncertain' for an unmapped reply ('maybe?')", async () => {
    const send = vi.fn().mockResolvedValue(makeConverseResponse('maybe?'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('uncertain');
  });

  it("resolves 'uncertain' for an empty reply ('')", async () => {
    const send = vi.fn().mockResolvedValue(makeConverseResponse(''));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('uncertain');
  });

  // ── Fail-closed: AWS error / timeout → uncertain, never throws ──────────────

  it("resolves 'uncertain' and never throws when send rejects (AWS error)", async () => {
    const send = vi.fn().mockRejectedValue(new Error('ModelNotReadyException'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    // Must resolve — NEVER reject — even when the underlying call fails.
    await expect(judge.evaluate(STUB_ITEM)).resolves.toBe('uncertain');
  });

  it("fail-closed invariant: NEVER resolves 'accepted' when send rejects", async () => {
    const send = vi.fn().mockRejectedValue(new Error('ThrottlingException'));
    const judge = new BedrockJudge({ modelId: MODEL_ID, region: 'us-east-1', client: { send } });

    const verdict = await judge.evaluate(STUB_ITEM);
    expect(verdict).not.toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// parseVerdict — direct unit tests (word-boundary matching, H1 security fix)
// ---------------------------------------------------------------------------
// These exercise the exported parseVerdict function directly to guard the
// fail-closed invariant: a substring of a verdict token MUST NOT produce a
// positive match (e.g. "unaccepted" must NOT match "accepted").

describe('parseVerdict — word-boundary matching', () => {
  it("returns 'uncertain' for 'unaccepted' (substring must NOT match 'accepted')", () => {
    expect(parseVerdict('unaccepted')).toBe('uncertain');
  });

  it("returns 'accepted' for an exact 'accepted' reply", () => {
    expect(parseVerdict('accepted')).toBe('accepted');
  });

  it("returns 'uncertain' for 'accepted or rejected' (ambiguous multi-token reply, L2)", () => {
    expect(parseVerdict('accepted or rejected')).toBe('uncertain');
  });

  it("returns 'uncertain' for an empty string", () => {
    expect(parseVerdict('')).toBe('uncertain');
  });
});
