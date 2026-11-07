import { randomBytes } from 'node:crypto';

/**
 * Crockford base32 alphabet — 32 unambiguous characters.
 * Uppercase only; excludes I, L, O, U to avoid visual confusion.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a ULID (Universally Unique Lexicographically Sortable Identifier).
 *
 * Format: 26 Crockford base32 characters (128 bits total)
 *   - Characters  0–9  : 48-bit timestamp (Date.now() milliseconds, big-endian)
 *   - Characters 10–25 : 80-bit cryptographic random (crypto.randomBytes(10))
 *
 * No runtime dependencies — uses only node:crypto.
 * Monotonic within the same millisecond is NOT guaranteed; for the staging_session
 * use-case (one session per (project,repo,branch) per TTL window), strict
 * monotonicity within a millisecond is not required.
 */
export function ulid(): string {
  const result = new Array<string>(26);

  // --- Timestamp: 48 bits → 10 Crockford base32 chars (5 bits each, big-endian) ---
  let t = Date.now();
  for (let i = 9; i >= 0; i--) {
    result[i] = ENCODING[t & 0x1f] as string;
    t = Math.floor(t / 32);
  }

  // --- Randomness: 80 bits (10 bytes) → 16 Crockford base32 chars (5 bits each) ---
  // Convert the 10 random bytes into a single BigInt, then extract 5-bit groups.
  const rand = randomBytes(10);
  let r = BigInt(0);
  for (let i = 0; i < 10; i++) {
    r = (r << 8n) | BigInt(rand[i] as number);
  }
  for (let i = 25; i >= 10; i--) {
    result[i] = ENCODING[Number(r & 0x1fn)] as string;
    r >>= 5n;
  }

  return result.join('');
}
