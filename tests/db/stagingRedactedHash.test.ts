/** SEC-M2: staging content_hash after a redacted quarantine (pure, no DB). */

import { describe, it, expect } from 'vitest';
import { stagingRedactedHash } from '../../src/db/promotionRepository.js';
import { sha256Hex } from '../../src/security/hash.js';

const H = 'a'.repeat(64);

describe('stagingRedactedHash', () => {
  it("redact 'none' keeps the current hash (null)", () => {
    expect(stagingRedactedHash('item-1', 'none', H)).toBeNull();
  });

  it.each(['spans', 'whole'] as const)('%s → sha256(item id : redacted hash)', (redact) => {
    expect(stagingRedactedHash('item-1', redact, H)).toBe(sha256Hex(`item-1:${H}`));
  });

  it('the same redacted content gives a different hash per item', () => {
    expect(stagingRedactedHash('item-1', 'whole', H)).not.toBe(
      stagingRedactedHash('item-2', 'whole', H),
    );
  });
});
