/**
 * Creates and returns a configured McpServer instance with all read tools
 * registered for the given dependency set.
 *
 * Called once per HTTP request (stateless transport pattern) by transport.ts
 * so each request gets a fresh, isolated server instance.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps } from './context.js';
import { registerReadTools, registerWriteTools } from './tools/index.js';

export function createMcpServer(deps: Deps): McpServer {
  const server = new McpServer({
    name: 'lpms-cloud',
    version: '0.1.0',
  });

  registerReadTools(server, deps);
  registerWriteTools(server, deps);

  return server;
}
