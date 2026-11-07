// Maps handler return values and thrown errors to MCP tool result objects.
// Opacity guarantee: raw errors, stack traces, tenant IDs, and resource names
// NEVER reach the agent through this module.

import { AppError, ErrorCode } from './appError.js';

/**
 * Minimal MCP tool result carrying text content only.
 * Shape matches @modelcontextprotocol/sdk's CallToolResult for text responses.
 */
export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

/**
 * Wraps a successful handler return value as an MCP tool result.
 * The value is JSON-serialized into a single text content item.
 */
export function toToolResult(value: unknown): ToolTextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

/**
 * Converts any thrown value into an opaque MCP tool error result.
 * - Known `AppError` → its pre-composed generic message.
 * - Anything else → INTERNAL generic message (no detail forwarded).
 *
 * This function MUST be called in every tool wrapper's catch block.
 */
export function toToolErrorResult(err: unknown): ToolTextResult {
  let message: string;

  if (err instanceof AppError) {
    // Use the pre-composed opaque message; never use err.cause or err.stack.
    message = err.opaqueMessage;
  } else {
    // Unknown error type — collapse to a generic internal message.
    // Deliberately do NOT forward (err as Error).message — it may leak internals.
    message = new AppError(ErrorCode.INTERNAL).opaqueMessage;
  }

  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
