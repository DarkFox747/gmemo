# Tasks: direct-memory-management (C5)

> spec ↔ design reconciled (direct-memory, promotion, memory-lifecycle deltas ↔ design batches A–H). Starts after C2, C3 and C4 land. TDD per task. Exact files: design.md § File Changes, batch named in each task.

- [x] 1.1 (A) Contracts + shared apply params (`provenance`, `approvedBy` as `$14/$15`) (design batch A) [declares:DirectContracts]
- [x] 2.1 (B) `evaluateCandidate` extraction + `promoteItem` humanApproved mode (design batch B) [consumes:DirectContracts]
- [x] 2.2 (C) `MemoryAdminRepository` list/detail/revisions + `createSingleItemSession` (design batches C, D) [consumes:DirectContracts]
- [x] 3.1 (E) `DirectMemoryService` (preview, create, amend, session lifecycle) (design batch E)
- [x] 3.2 (F) Routes in `memoryRoutes.ts` + audit actions (design batch F)
- [x] 4.1 (G) Composition + smoke + reachability test (design batch G)
- [x] 4.2 (H) Docs (design batch H)
- [x] 5.1 Gate: suite + DB gate, lint, build, compose, smoke, manual preview/create/amend/409 walk

## Phase 6: Verify remediation

- [x] 6.1 Round-1 fixes: SEC M1 (web-session reaper job), SEC M2 (judge unavailable → 503 on confirm), SEC L (cursor date validation, dedup non-active, detail PII), CR M1-M4, CR L3-L4
