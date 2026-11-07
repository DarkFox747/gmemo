/**
 * Zod input schemas for the three MCP read tools.
 *
 * These are exported as ZodRawShape objects (plain key→ZodType records) so
 * they can be passed directly to McpServer.tool() for registration and also
 * composed into z.object() for standalone parsing.
 *
 * Single source of truth: changing these shapes changes both the MCP tool
 * signature and any parse-time validation.
 */

import { z } from 'zod';

/** All valid memory type values (contract §1). */
export const MEMORY_TYPES = [
  'decision',
  'constraint',
  'gotcha',
  'pattern',
  'integration_note',
  'domain_rule',
  'outcome',
] as const;

// ---------------------------------------------------------------------------
// recall(query, scope?, types?, limit?)  — contract §2
// ---------------------------------------------------------------------------

export const recallInputShape = {
  query: z.string().max(1000).describe('Natural language query or search terms'),
  scope: z
    .enum(['repo', 'project'])
    .optional()
    .describe('Search scope; "project" (default) broadens beyond the repo'),
  types: z
    .array(z.enum(MEMORY_TYPES))
    .optional()
    .describe('Optional memory-type filter; omit to search all types'),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Max records to return; default 8 (contract §8)'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque pagination cursor from a prior recall response (design D5)'),
};

// ---------------------------------------------------------------------------
// get_memory(handle)  — contract §2
// ---------------------------------------------------------------------------

export const getMemoryInputShape = {
  handle: z
    .string()
    .describe('Opaque handle returned by a prior recall call (contract §1)'),
};

// ---------------------------------------------------------------------------
// get_context()  — contract §2, no parameters
// ---------------------------------------------------------------------------

export const getContextInputShape = {};

/** All valid staging operation values (contract §3). */
export const STAGING_OPS = ['add', 'amend', 'supersede', 'deprecate'] as const;

// ---------------------------------------------------------------------------
// remember(op, type, title, summary, body, fields?, target_handle?)  — contract §3
// ---------------------------------------------------------------------------

export const rememberInputShape = {
  op: z
    .enum(STAGING_OPS)
    .describe('Suggested operation; the judge may reclassify at promotion'),
  type: z.enum(MEMORY_TYPES).describe('Memory type (contract §1)'),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  fields: z
    .record(z.unknown())
    .optional()
    .describe('Per-type fields (skill-guided)'),
  target_handle: z
    .string()
    .optional()
    .describe('Required for amend/supersede/deprecate'),
};

// ---------------------------------------------------------------------------
// list_staged()  — contract §4, no parameters
// ---------------------------------------------------------------------------

export const listStagedInputShape = {};

// ---------------------------------------------------------------------------
// discard_staged(item_id)  — contract §5
// ---------------------------------------------------------------------------

export const discardStagedInputShape = {
  item_id: z
    .string()
    .uuid()
    .describe("UUID of a staging item in the caller's own session"),
};
