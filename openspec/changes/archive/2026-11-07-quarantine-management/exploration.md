# Exploration: quarantine-management (C3)

One crombie-explore scope (quarantine data, redaction, jobs). Status: PARTIAL (only the judge logging audit was not done).

- **quarantine (0004:41-67)**: id, project_id, repo_id NULL (SET NULL), origin_session_id text, origin_item_id uuid (no FK), op, type, title/summary/body with CHECKs 120/200/2000, fields, content_hash, judge_reason NOT NULL, author_identity NOT NULL, quarantined_at default now(), expires_at NULL (never written). Indexes: project_id; partial expires_at. Missing: criterion, reason_code, related_memory_id, restored_*.
- **Reason strings written today** (C1 code): `secret_detected`, `embedded_instructions`, `sanitize_failed` (sanitize); `duplicate_content` (hash conflict, R3, apply duplicate); `security_second_layer` (R2); `specificity` (R4). C2 adds `human_review: <reason>`. The C3 enum lacks `sanitize_failed`, `specificity` and `security_second_layer`, so a mapping decision is needed.
- **Redaction today**: whole-field `[REDACTED: secret detected]` + `fields → {}` in both quarantine and staging_item (`promotionRepository.ts:754-760, 356-362`). Tests assert it (`tests/db/promotion.integration.test.ts:817-892`).
- **secretScan ranges**: feasible with `g` + `matchAll`; overlapping categories are possible, so merge the ranges.
  - Risk: PEM matches only the header, so the range must extend to `-----END … PRIVATE KEY-----` or the end of the text.
  - Risk: `secret_assignment` includes the keyword and `\s*` crosses newlines, so redact the value only (lookbehind, `[ \t]*`).
  - Risk: the sentinel can be longer than the match, overflowing the CHECK limits.
  - Fields: redact per string leaf, not on the joined JSON.
- **Exposure map**: memory/revision are written only after sanitize; `access_log.detail` holds ids only; logs hold categories only. Residuals: `quarantine.content_hash` of secret-bearing content (brute-force risk for low-entropy secrets), DB WAL/backups (out of app control).
- **Restore session**: `staging_session(project_id, repo_id NOT NULL, branch, opened_by NOT NULL)`. The partial unique index is per branch, so `restore/<quarantineId>` gets its own slot and is never swept by PR promotion. Caveats: `quarantine.repo_id` is nullable; `promote()` uses a CI actor and writes `origin_branch`, so restore should keep the original branch and use a user actor.
- **Author** = `staging_item.author_identity` = `principal.subject` (`app_user.idp_subject`) for users, so "author sees own" compares against `principal.subject`.
- **Jobs**: no precedent. Mount point is between `/promote` and the error handler (`src/http/app.ts:89-106`). Script pattern: tsx CLI with a main-module guard (`src/db/migrate.ts:104-108`). Token config follows the superRefine prod-guard pattern.
