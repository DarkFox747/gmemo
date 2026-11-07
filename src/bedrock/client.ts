/**
 * Shared Bedrock client module — narrow seam, factory, and timeout helper.
 *
 * Follows the CognitoVerifier pattern from src/auth/authenticator.ts:
 * declare a narrow structural interface over the one SDK method we use (.send),
 * inject it at construction, default to a real BedrockRuntimeClient. Tests
 * inject { send: vi.fn() } — no live AWS, no vi.mock gymnastics.
 *
 * Timeout uses Node 22 built-in AbortController only (YAGNI; no @smithy/* dep).
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

/**
 * Narrow structural interface over BedrockRuntimeClient.
 * Only the .send() shape we need is declared, keeping the seam minimal.
 * The real BedrockRuntimeClient satisfies this structurally.
 * Tests inject a { send: vi.fn() } fake without live AWS credentials.
 */
export interface BedrockInvoker {
  send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/**
 * Builds a real BedrockRuntimeClient with the given region and retry policy.
 * Credentials come from the default AWS provider chain (task role in prod) —
 * only region is passed explicitly, per the project's "no hidden config" convention.
 *
 * Returns BedrockInvoker so callers don't import BedrockRuntimeClient directly.
 */
export function makeBedrockRuntimeClient({
  region,
  maxAttempts,
}: {
  region: string;
  maxAttempts: number;
}): BedrockInvoker {
  return new BedrockRuntimeClient({ region, maxAttempts });
}

/**
 * Sends a Bedrock command with a per-request timeout enforced by AbortController.
 * The timer is cleared in a finally block so it is always cancelled on settle
 * (success, error, or abort) — no timer leaks.
 *
 * If timeoutMs elapses before the send resolves/rejects, the signal is aborted
 * and the SDK rejects the promise. That rejection propagates to the caller.
 */
export async function sendWithTimeout(
  client: BedrockInvoker,
  command: object,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
