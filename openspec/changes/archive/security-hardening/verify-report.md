# Verify Report — security-hardening

## Verdict: PASS (post-remediation)

- Pre-remediation: FAIL — 1 HIGH (rate-limit key spoofability) + 4 LOW.
- Remediation closed all 5 (H1 + L1–L4): explicit right-most-XFF `keyGenerator`
  (unforgeable ALB-appended key) + two-entry XFF regression test proving the key;
  default `'true'`; HSTS assertion; explicit return type; x-powered-by comment.
- Re-gate: build/lint clean, **462 tests / 0 failed**, terraform fmt/validate clean.
- **Verdict flips to PASS**: HIGH closed (fail-safe, verified at source by the
  regression test), gates green.

Gate (original apply): build/lint clean, 460 tests, terraform clean. Reviewer: 4 LOW.
Security: 1 HIGH (rate-limit key).

## Findings

### HIGH
- **H1 (security) — rate-limit key may be spoofable via pre-seeded `X-Forwarded-For`.**
  Security and architect/reviewer DISAGREE on whether `trust proxy = 1` + the default
  `keyGenerator` (`req.ip`) resolves to the ALB-appended (right-most, non-spoofable)
  entry or the client-controlled (left) entry, given the ALB APPENDS to XFF
  (`[fake, alb-real]`). Rather than merge an unverified contradiction, remediate
  FAIL-SAFE and prove it at the source: add an explicit `keyGenerator` that reads the
  RIGHT-MOST XFF entry (always ALB-appended, unforgeable for the single-ALB topology),
  and add a two-entry XFF regression test (`10.1.0.1, 10.1.0.99`) asserting the
  right-most is used. This is correct regardless of the `proxy-addr` indexing debate.
  Keep `trust proxy = 1` (express-rate-limit v8 validates it; `true` would be rejected).

### LOW (fix in the same batch — cheap)
- **L1 (review) — `RATE_LIMIT_ENABLED` defaults to `'false'`**, diverging from design
  (`'true'`). Prod guard covers prod, but local `NODE_ENV=development` silently has it
  off. Set default `'true'`.
- **L2 (review) — `app.disable('x-powered-by')` redundant with helmet's `hidePoweredBy`.**
  Keep as defense-in-depth WITH a one-line comment, or drop. (Keep + comment.)
- **L3 (review) — tests don't assert HSTS** (the header with the most operational
  weight given ALB TLS). Add `expect(res.headers['strict-transport-security']).toBeDefined()`.
- **L4 (review) — `makeRateLimiter` inferred return type.** Add explicit `: RequestHandler`.

### Deferred (backlog — acknowledged pilot posture)
- `/health`, `GET/DELETE /mcp` (405) unlimited — cheap fixed responses; WAF rate rule at GA.
- In-memory store is per-task — horizontal scale needs a shared store (Redis). Documented.

## Clean (no action)
Prod guard correct + terraform sets `RATE_LIMIT_ENABLED=true`; helmet posture sound
(HSTS/nosniff/frame-deny, CSP off for JSON API, x-powered-by off); limiter before auth
without weakening auth; opaque 429; no secrets; no SSRF/injection; MCP transport intact.

## Remediation plan
Single worker: H1 (explicit right-most-XFF keyGenerator + two-entry XFF regression
test) + L1–L4. Re-gate (node + terraform). Verdict flips to PASS when H1 is closed and
gates stay green.
