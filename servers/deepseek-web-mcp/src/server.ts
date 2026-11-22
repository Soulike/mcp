import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DeepSeekWebClient } from './services/deepseek-client.ts';
import { registerTools } from './tools/index.ts';
import { SERVER_VERSION } from './version.ts';

export interface ServerDependencies {
  client?: DeepSeekWebClient | undefined;
}

export function createServer(deps?: ServerDependencies): McpServer {
  const server = new McpServer({
    name: 'deepseek-web-mcp',
    version: SERVER_VERSION,
  });

  registerTools(server, deps?.client);
  return server;
}
