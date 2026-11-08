/**
 * C5 proposal risk "human approval becomes a bypass for agents": the MCP
 * remember tool, called end to end over InMemoryTransport, never reaches the
 * promote service (neither promote() nor promoteItem, let alone with
 * humanApproved). The item stays pending in staging.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeStubAuthServices } from '../auth/fakes.js';
import { InMemoryStagingRepository } from '../staging/fakes.js';
import type { PromoteServiceLike } from '../../src/promote/promoteService.js';

class SpyPromoteService implements PromoteServiceLike {
  calls: string[] = [];
  promote(): never {
    this.calls.push('promote');
    throw new Error('promote must not be reached from MCP');
  }
  promoteItem(): never {
    this.calls.push('promoteItem');
    throw new Error('promoteItem must not be reached from MCP');
  }
}

describe('humanApproved is unreachable from MCP', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('remember stages a pending item and never calls the promote service', async () => {
    const spy = new SpyPromoteService();
    const staging = new InMemoryStagingRepository();
    const deps = {
      ...makeStubAuthServices({ promoteService: spy, stagingRepository: staging }),
      resolutionInput: {
        authorization: 'Bearer x',
        gitRemote: 'git@github.com:o/r.git',
        branch: 'feat/x',
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(deps).connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'remember',
      arguments: {
        op: 'add',
        type: 'decision',
        title: 'Use pg pool of 30',
        summary: 'Burst traffic starved the 10-connection pool.',
        body: 'Set PGPOOL_MAX=30 in src/db/pool.ts after the load test.',
      },
    });

    expect(res.isError).toBeFalsy();
    expect(staging.insertedItemCount).toBe(1);
    expect(staging.insertedParams[0]!.judgeState).toBe('pending');
    expect(staging.singleItemSessions).toHaveLength(0);
    expect(spy.calls).toEqual([]);
  });
});
