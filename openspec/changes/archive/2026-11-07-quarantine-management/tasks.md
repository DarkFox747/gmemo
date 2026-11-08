# Tasks: quarantine-management (C3)

> spec ↔ design reconciled (quarantine domain ↔ design batches A–I; design adds target_memory_id/target_revision, covered by the spec's "original target" clause). Starts after C2 lands. TDD per task. Exact files: design.md § File Changes, batch named in each task.

- [x] 1.1 (A) Migration `migrations/0008_quarantine_management.sql`, config (`QUARANTINE_RETENTION_DAYS`, `JOBS_TOKEN`), contract types, `classifyQuarantine` (design batch A) [declares:QuarantineContracts]
- [x] 2.1 (B) Span redaction `scanForSecretsWithRanges` + redaction modes (design batch B) [consumes:QuarantineContracts] [declares:SpanRedaction]
- [x] 2.2 (E) Jobs router + purge service + `scripts/jobs/quarantine-purge.ts` (design batch E) [consumes:QuarantineContracts] [declares:JobsRouter]
- [x] 2.3 (F) `authorizeProjectMember` gate (design batch F) [consumes:QuarantineContracts]
- [x] 3.1 (C) Repository: quarantine inserts classified + span mode + recomputed hash; quarantine list/detail/restore SQL (design batch C) [consumes:SpanRedaction]
- [x] 3.2 (D) `PromoteService.promoteItem` + QuarantineService restore (design batch D)
- [x] 4.1 (G) API routes (design batch G)
- [x] 4.2 (H) Composition root, jobs mount, package scripts, smoke (design batch H)
- [x] 4.3 (I) Docs (design batch I)
- [x] 5.1 Gate: suite + DB gate (incl. secret-never-persisted), lint, build, compose, smoke, manual list/detail/restore/purge walk

## Phase 6: Verify remediation

- [x] 6.1 Round-1 fixes: SEC M (cross-field PEM, staging hash, jobs open mode), SEC L (openai range, restore session collision + reserved prefix, restore of redacted rows, jobs rate limit, judgeReason for authors), CR M (isJobsEnabled helper + test)
