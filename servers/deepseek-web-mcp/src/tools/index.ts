import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DeepSeekWebClient } from '../services/deepseek-client.ts';
import { registerFetchTool } from './fetch.ts';
import { registerSearchTool } from './search.ts';

export function registerTools(
  server: McpServer,
  client: DeepSeekWebClient | undefined,
): void {
  registerSearchTool(server, client);
  registerFetchTool(server, client);
}
