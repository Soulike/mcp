import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.ts';

await describe('template-mcp server', async () => {
  await it('lists and executes the echo tool over InMemoryTransport', async () => {
    const server = createServer();
    const client = new Client({
      name: 'template-mcp-test-client',
      version: '0.0.0',
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['echo'],
      );

      const result = await client.callTool({
        name: 'echo',
        arguments: { message: 'hello mcp' },
      });

      assert.deepEqual(result.content, [{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
