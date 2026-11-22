#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';
import { createDeepSeekWebClient } from './services/deepseek-client.ts';

function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const rawApiKey = process.env['DEEPSEEK_API_KEY'];
  const apiKey =
    rawApiKey !== undefined && rawApiKey.trim() !== '' ? rawApiKey : undefined;
  const client =
    apiKey !== undefined ? createDeepSeekWebClient({ apiKey }) : undefined;

  const server = createServer({ client });
  const transport = new StdioServerTransport();

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`Received ${signal}, shutting down deepseek-web-mcp...`);
    server.close().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        console.error('Error closing deepseek-web-mcp:', error);
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await server.connect(transport);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error('Failed to start deepseek-web-mcp:', error);
    process.exitCode = 1;
  });
}
