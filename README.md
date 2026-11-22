# Soulike MCP Servers

A monorepo of Model Context Protocol (MCP) servers for Node.js (`>=24`), designed to run directly with `npx`.

## Servers

No public MCP servers have been published from this repository yet. Each server lives under `servers/<name>-mcp` with its own usage documentation at `servers/<name>-mcp/README.md`.

| Server        | Package               | Description                          | Documentation                  |
| ------------- | --------------------- | ------------------------------------ | ------------------------------ |
| _Coming soon_ | `@soulike/<name>-mcp` | Placeholder for upcoming MCP servers | `servers/<name>-mcp/README.md` |

## Usage

Once a server is published, run it directly via `npx` or configure it in your MCP client (replace `<name>-mcp` with a server package listed above):

```json
{
  "mcpServers": {
    "<name>": {
      "command": "npx",
      "args": ["-y", "@soulike/<name>-mcp"]
    }
  }
}
```

See each server's `servers/<name>-mcp/README.md` for available tools, arguments, and environment variables.

## Development

Requires Node.js `>=24` and `pnpm`. After cloning, install dependencies with `pnpm install` and verify with `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test`. See [`AGENTS.md`](./AGENTS.md) and [`servers/template-mcp`](./servers/template-mcp) for workspace conventions.

## License

[MIT](./LICENSE)
