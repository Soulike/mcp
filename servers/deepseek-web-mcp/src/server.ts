import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createDeepSeekWebClient,
  type DeepSeekWebClient,
} from './services/deepseek-client.ts';
import { registerTools } from './tools/index.ts';
import { SERVER_VERSION } from './version.ts';

export interface ServerDependencies {
  client?: DeepSeekWebClient | undefined;
  apiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
}

function resolveClient(
  deps?: ServerDependencies,
): DeepSeekWebClient | undefined {
  if (deps?.client !== undefined) {
    return deps.client;
  }
  const apiKey = deps?.apiKey;
  if (apiKey !== undefined && apiKey.trim() !== '') {
    return createDeepSeekWebClient({ apiKey, fetchFn: deps?.fetch });
  }
  return undefined;
}

export function createServer(deps?: ServerDependencies): McpServer {
  const server = new McpServer({
    name: 'deepseek-web-mcp',
    version: SERVER_VERSION,
  });

  registerTools(server, resolveClient(deps));
  return server;
}
