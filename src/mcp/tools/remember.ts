/**
 * remember tool handler — contract §3.
 *
 * Pure handler: authentication, authorization, and audit are the caller's
 * responsibility (Batch E wrapper in index.ts). This file only exports the
 * handler function.
 *
 * 8-step algorithm (write-path design.md §"rememberHandler"):
 *  1. assertValidFields — unknown key → INVALID_REFERENCE
 *  2. op↔target validation — add+handle or non-add−handle → INVALID_REFERENCE
 *  3. Resolve target (non-add only); stale handle → judgeState='uncertain'
 *  4. assertNoSecrets — any finding → PERMISSION_DENIED (before any DB write)
 *  5. Compute contentHash = sha256Hex of a fixed-key-order canonical JSON string
 *  6. findOrCreateOpenSession — lazy upsert with sliding 7-day TTL
 *  7. insertStagingItem — idempotent; dedup path returns the same id
 *  8. Return { id, state, sessionId, contentHash }
 */

import type { RememberRequest, RememberResult } from '../../contracts/tools.js';
import type { RequestContext, HandlerDeps } from '../context.js';
import { decodeHandle, isHandleStale } from '../handle.js';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { assertValidFields } from '../fieldsPolicy.js';
import { assertNoSecrets } from '../../security/secretScan.js';
import { sha256Hex } from '../../security/hash.js';

export async function rememberHandler(
  input: RememberRequest,
  ctx: RequestContext,
  deps: HandlerDeps,
): Promise<RememberResult> {
  // Step 1: per-type fields validation
  assertValidFields(input.type, input.fields ?? {});

  // M1: bound fields JSON size to prevent ReDoS/CPU-exhaustion via the secret-scan regexes.
  // 2000 chars mirrors the body budget; runs before the secret-scan (step 4).
  if (JSON.stringify(input.fields ?? {}).length > 2000) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }

  // Step 2: op↔target consistency
  if (input.op === 'add' && input.target_handle !== undefined) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }
  if (input.op !== 'add' && input.target_handle === undefined) {
    throw new AppError(ErrorCode.INVALID_REFERENCE);
  }

  // Step 3: resolve target (non-add only)
  let judgeState: 'pending' | 'uncertain' = 'pending';
  let targetMemoryId: string | null = null;
  let targetRevision: number | null = null;

  if (input.op !== 'add') {
    // decodeHandle throws AppError(INVALID_REFERENCE) on any malformed handle
    const decoded = decodeHandle(input.target_handle as string);

    const detail = await deps.memoryRepository.getMemoryByHandle(ctx.tenant, decoded.memoryId);
    if (detail === null) {
      throw new AppError(ErrorCode.INVALID_REFERENCE);
    }

    const stale = isHandleStale(detail.memory.current_revision, decoded.revisionNo);
    judgeState = stale ? 'uncertain' : 'pending';
    targetMemoryId = decoded.memoryId;
    targetRevision = decoded.revisionNo;
  }

  // Step 4: secret-scan BEFORE any DB write (fail-closed — assertNoSecrets throws on any finding)
  assertNoSecrets(
    input.title,
    input.summary,
    input.body,
    JSON.stringify(input.fields ?? {}),
  );

  // Step 5: content hash over a fixed-key-order canonical JSON string
  const canonical = JSON.stringify({
    op: input.op,
    type: input.type,
    title: input.title,
    summary: input.summary,
    body: input.body,
    fields: input.fields ?? {},
    target: targetMemoryId,
  });
  const contentHash = sha256Hex(canonical);

  // Step 6: lazy-create or reuse the one open session for this (project, repo, branch)
  const sessionId = await deps.stagingRepository.findOrCreateOpenSession(
    ctx.tenant,
    ctx.actor.actorId,
  );

  // Step 7: idempotent insert; dedup path returns the same id unchanged
  const res = await deps.stagingRepository.insertStagingItem(sessionId, {
    op: input.op,
    type: input.type,
    title: input.title,
    summary: input.summary,
    body: input.body,
    fields: input.fields ?? {},
    contentHash,
    targetMemoryId,
    targetRevision,
    judgeState,
    authorIdentity: ctx.actor.actorId,
  });

  // Step 8: return the superset result (wrapper projects { id, state } to the agent)
  return {
    id: res.id,
    state: res.judgeState as 'pending' | 'uncertain',
    sessionId,
    contentHash,
  };
}
