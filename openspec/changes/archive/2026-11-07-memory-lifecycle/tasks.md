# Tasks: memory-lifecycle (C4)

> spec ↔ design reconciled (memory-lifecycle, memory-read, promotion deltas ↔ design batches A–G). Starts after C2 and C3 land. TDD per task. Exact file lists: design.md § File Changes, batch named in each task.

- [x] 1.1 (A) Schema, config, contracts: migrations `migrations/0009_memory_enum_values.sql`, `migrations/0010_memory_lifecycle.sql`, config `REVALIDATION_DAYS`, contract types (design batch A) [declares:LifecycleContracts]
- [x] 2.1 (B) Apply sets `revalidate_at` (design batch B) [consumes:LifecycleContracts]
- [x] 2.2 (C) Lifecycle repository + service (design batch C) [consumes:LifecycleContracts] [declares:LifecycleService]
- [x] 2.3 (D) Per-status read-exclusion tests, unit + DB-gated (design batch D) [consumes:LifecycleContracts]
- [x] 3.1 (E) Routes + audit actions (design batch E) [consumes:LifecycleService]
- [x] 4.1 (F) Composition, `revalidation-sweep` job, `scripts/jobs/revalidation.ts`, `pnpm job:revalidation`, smoke (design batch F)
- [x] 4.2 (G) Docs (design batch G)
- [x] 5.1 Gate: suite + DB gate, lint, build, compose, smoke, manual job + confirm/retire/retire-by-pr walk
