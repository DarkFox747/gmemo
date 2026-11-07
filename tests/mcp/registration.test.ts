import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeStubAuthServices } from '../auth/fakes.js';

/**
 * T044 / T015: MCP tool registration — wiring conformance.
 *
 * Connects an SDK Client to createMcpServer() over InMemoryTransport (no real
 * network) and calls tools/list. Asserts that EXACTLY six tools are registered
 * with the names and non-empty input schemas defined in the facade contract §2-§5.
 * This guards against a handler existing in source but never being wired into the server.
 *
 * createMcpServer(deps: Deps) requires a full Deps bag including AuthServices
 * singletons. tool/list does not invoke any tool handler, so stub services that
 * never exercise the auth chain are sufficient here.
 */

/** All six tool names exposed by the facade (contract §2–§5). */
const EXPECTED_TOOL_NAMES = [
  'recall',
  'get_memory',
  'get_context',
  'remember',
  'list_staged',
  'discard_staged',
] as const;

/** Minimal stub Deps bag for registration tests (tools/list never calls handlers). */
function makeStubDeps() {
  return {
    ...makeStubAuthServices(),
    resolutionInput: { authorization: undefined, gitRemote: undefined, branch: undefined },
  };
}

describe('createMcpServer — tool registration', () => {
  let client: Client | undefined;

  afterEach(async () => {
    // Close the client transport after each test to avoid open handle warnings.
    if (client) {
      await client.close().catch(() => {
        // best-effort cleanup
      });
      client = undefined;
    }
  });

  it('exposes exactly six tools: recall, get_memory, get_context, remember, list_staged, discard_staged', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    // Exactly six tools — no extras, no missing
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.length);

    const registeredNames = tools.map((t) => t.name).sort();
    const expectedNames = [...EXPECTED_TOOL_NAMES].sort();
    expect(registeredNames).toEqual(expectedNames);
  });

  it('reports serverInfo name gmemo', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe('gmemo');
  });

  it('each tool has a non-empty inputSchema', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(
        tool.inputSchema,
        `tool "${tool.name}" must have a non-empty inputSchema`,
      ).toBeDefined();

      // inputSchema must be an object (not null, not a primitive)
      expect(typeof tool.inputSchema).toBe('object');
      expect(tool.inputSchema).not.toBeNull();

      // The schema must describe at least a "type" or "properties" key so it
      // is genuinely a JSON Schema shape, not an empty object.
      const schemaKeys = Object.keys(tool.inputSchema as object);
      expect(schemaKeys.length).toBeGreaterThan(0);
    }
  });

  it('recall tool has a query property in its inputSchema', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    const recallTool = tools.find((t) => t.name === 'recall');
    expect(recallTool).toBeDefined();

    // recall must declare a "query" parameter (contract §2)
    const schema = recallTool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).toHaveProperty('query');
  });

  it('get_memory tool has a handle property in its inputSchema', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    const getMemoryTool = tools.find((t) => t.name === 'get_memory');
    expect(getMemoryTool).toBeDefined();

    // get_memory must declare a "handle" parameter (contract §2)
    const schema = getMemoryTool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).toHaveProperty('handle');
  });

  it('remember tool exposes op, type, title, summary, body in its inputSchema', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    const rememberTool = tools.find((t) => t.name === 'remember');
    expect(rememberTool).toBeDefined();

    // remember must declare all required parameters (contract §3)
    const schema = rememberTool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    for (const key of ['op', 'type', 'title', 'summary', 'body']) {
      expect(schema.properties, `remember inputSchema missing "${key}"`).toHaveProperty(key);
    }
  });

  it('discard_staged tool exposes item_id in its inputSchema', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const mcpServer = createMcpServer(makeStubDeps());
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    const discardTool = tools.find((t) => t.name === 'discard_staged');
    expect(discardTool).toBeDefined();

    // discard_staged must declare "item_id" (contract §5)
    const schema = discardTool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    expect(schema.properties).toHaveProperty('item_id');
  });
});
