// Judge seam — see design.md §"Judge seam" and §Decision 5.
// Verdict and JudgeItem are the shared contract between PromoteService,
// DeterministicJudge (DEV/TEST), and BedrockJudge (production skeleton).

import type { MemoryType } from '../contracts/memory.js';

export type Verdict = 'accepted' | 'rejected' | 'uncertain';

export interface JudgeItem {
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

export interface Judge {
  evaluate(item: JudgeItem): Promise<Verdict>;
}
