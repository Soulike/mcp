import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'template-mcp',
    version: '0.0.0',
  });

  server.registerTool(
    'echo',
    {
      description: 'Echoes back the provided message.',
      inputSchema: {
        message: z.string().min(1),
      },
    },
    ({ message }) => ({
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
    }),
  );

  return server;
}
