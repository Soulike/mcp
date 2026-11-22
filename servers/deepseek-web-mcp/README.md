# `@soulike/deepseek-web-mcp`

MCP server exposing [DeepSeek Web Search and Fetch APIs](https://api-docs.deepseek.com/zh-cn/guides/search.md) over stdio transport.

## Requirements

- Node.js `>=24`
- A DeepSeek API key set in `DEEPSEEK_API_KEY`

## Configuration

Run directly with `npx`:

```json
{
  "mcpServers": {
    "deepseek-web": {
      "command": "npx",
      "args": ["-y", "@soulike/deepseek-web-mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "your-deepseek-api-key"
      }
    }
  }
}
```

## Tools

### `deepseek_search`

Search the web using `POST https://api.deepseek.com/v1/tools/search`.

- `query` (string, required): 1–128 Unicode characters, non-whitespace. Supports `site:`, `-site:`, `-`, `-"..."`, `"..."`, `lang:`, `after:`, and `before:` operators.
- `count` (integer, optional): Number of results (`1`–`50`, default `10`).
- `ori_question` (string | null, optional): Original user question (1–128 Unicode characters).
- `localization` (string, optional): IP address for localized results.
- `need_content` (boolean, optional): Include full page text in `content` (default `false`).

### `deepseek_fetch`

Fetch a web page as Markdown using `POST https://api.deepseek.com/v1/tools/fetch`.

- `url` (string, required): HTTP/HTTPS URL with a host, max 8192 characters, without embedded username or password.
