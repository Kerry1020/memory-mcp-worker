# memory-mcp-worker

[![CI](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)

English | [简体中文](README.zh-CN.md)

A Cloudflare Worker that exposes a small, persistent memory store as an [MCP](https://modelcontextprotocol.io) server: agents can save, search, list, read and delete text memories, all stored in Cloudflare KV.

## Features

- Five tools: `memory_save`, `memory_list`, `memory_search`, `memory_get`, `memory_delete`
- MCP over Streamable HTTP (JSON responses) at `POST /mcp`, no SDK dependencies
- Protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` (negotiated on `initialize`, latest is the fallback)
- `initialize`, `ping`, `tools/list`, `tools/call`, notifications, JSON-RPC batches
- Tool results include both `content` (text) and `structuredContent`; tool failures are returned with `isError: true`
- Optional bearer-token auth (`MCP_AUTH_TOKEN`), configurable CORS origin
- Input validation and size limits; recency ordering via KV metadata (no full scan of values)

## Quick start

```bash
git clone https://github.com/Kerry1020/memory-mcp-worker.git
cd memory-mcp-worker
npm install
npm run dev                          # http://localhost:8789 with a local KV simulation
curl -s http://localhost:8789/healthz
```

To deploy, create your own KV namespace, set a token and run `npm run deploy` (see [Deploy](#deploy)). Then point your MCP client at `https://<your-worker>.workers.dev/mcp`.

## Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `memory_save` | `content` (required), `id`, `title`, `tags[]`, `source` | Create a memory (omit `id`, or pass a new custom `id`) or overwrite an existing one (pass its `id`). On update, `created_at` is kept and `title` / `tags` / `source` are replaced by what you send. |
| `memory_list` | `keyword`, `limit` (1-100, default 20) | List the most recently updated memories, optionally filtered by keyword. |
| `memory_search` | `keyword` (required), `limit` (1-100, default 20) | Case-insensitive substring search over id, title, content, tags and source. |
| `memory_get` | `id` (required) | Read one memory with full content. |
| `memory_delete` | `id` (required) | Delete one memory. |

`memory_list` and `memory_search` return summaries (id, title, tags, source, timestamps and a 160-character `preview`) plus `total_matched`, `returned` and `truncated_scan`. Use `memory_get` for the full content. A missing id returns `{ "ok": false, "error": "not_found" }`.

`GET /` and `GET /healthz` are public health/info endpoints (not MCP tools).

### Limits

| Field | Limit |
|-------|-------|
| `content` | 100,000 characters (line breaks preserved) |
| `title` | 500 characters (whitespace collapsed) |
| `source` | 200 characters |
| `id` | 128 characters, no control characters |
| `keyword` | 200 characters |
| `tags` | up to 20 tags of up to 64 characters, lower-cased and de-duplicated (extra tags are dropped, long tags truncated) |
| request body | 1 MiB |

Over-length `content`, `title`, `source`, `id` and `keyword` values are rejected. `memory_list` / `memory_search` consider up to 5,000 keys and fetch up to 500 values per call; `truncated_scan: true` in the result means a limit was hit.

## How it works

Each memory is stored in the KV namespace bound as `MEMORY_KV` under the key `mem:<id>`. The value is JSON:

```json
{ "id": "m_…", "title": "…", "content": "…", "tags": ["…"], "source": "…", "created_at": "…", "updated_at": "…" }
```

KV metadata `{ updated_at, created_at }` is written alongside, so listing can sort by recency from `KV.list()` alone. Items written by v0.1 (no metadata) are still listed; they are read once per listing to learn their timestamps, and gain metadata the next time they are saved.

KV is eventually consistent (writes can take up to ~60 s to appear in other locations / in `list`) and has no transactions: concurrent updates to the same `id` are last-writer-wins.

## Configuration

| Name | Required | Secret | Default | Description |
|------|----------|--------|---------|-------------|
| `MEMORY_KV` | Yes | No | (none) | KV namespace binding that stores memories. Configure `id` / `preview_id` in `wrangler.toml`. Without it every tool call fails with `missing_kv_binding_MEMORY_KV`. |
| `MCP_AUTH_TOKEN` | No (strongly recommended) | Yes | unset | When set, every request to `/mcp` requires `Authorization: Bearer <token>`; otherwise `401`. |
| `CORS_ALLOW_ORIGIN` | No | No | `*` | Value of `Access-Control-Allow-Origin` on all responses. |

For local development, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and set values there.

## MCP client config

Claude Code (native Streamable HTTP):

```bash
claude mcp add --transport http memory https://<your-worker>.workers.dev/mcp

# with MCP_AUTH_TOKEN set on the worker
claude mcp add --transport http memory https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude Desktop, Cursor and other stdio-only clients via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-worker>.workers.dev/mcp",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}"
      ],
      "env": {
        "AUTH_TOKEN": "<token>"
      }
    }
  }
}
```

Drop the `--header` arguments and `env` block if auth is disabled.

## curl examples

```bash
URL=http://localhost:8789/mcp     # or https://<your-worker>.workers.dev/mcp
AUTH=()                           # or AUTH=(-H "Authorization: Bearer $TOKEN")

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_save","arguments":{"title":"Deploy notes","content":"Use wrangler 4.\nRotate the token monthly.","tags":["ops"]}}}'

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"keyword":"wrangler"}}}'

curl -s http://localhost:8789/healthz
```

## Security notes

- Auth is **off by default**. Without `MCP_AUTH_TOKEN`, anyone who knows the URL can read, overwrite and delete every memory. For any public deployment, set a token:
  ```bash
  npx wrangler secret put MCP_AUTH_TOKEN
  ```
  Tokens are compared in constant time (SHA-256 digests).
- `GET /`, `GET /healthz` and `OPTIONS` preflight are always unauthenticated. The health response shows the server name, version, tool list and whether auth is enabled (`"auth": "bearer"` or `"none"`); it never shows memory data.
- CORS defaults to `*`. Set `CORS_ALLOW_ORIGIN` if browsers should only reach the worker from one origin. This is a browser-side control, not access control.
- Request bodies over 1 MiB are rejected, and unhandled errors return a generic `internal_error` without a stack trace.
- Memories are stored in plain JSON in your KV namespace. Don't store secrets you would not keep in KV.

## Development

Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: local secrets
npm run dev                      # wrangler dev on http://localhost:8789 (local KV simulation)
npm test                         # node:test suite with an in-memory KV mock
npm run build                    # wrangler dry-run bundle into dist/
```

### Project structure

```
memory-mcp-worker/
├── src/
│   ├── index.js    # Worker entry: routing, CORS, auth
│   ├── mcp.js      # JSON-RPC / MCP protocol handling
│   ├── http.js     # HTTP helpers (JSON, CORS, body limits, bearer auth)
│   ├── tools.js    # MCP tool definitions and dispatch
│   └── store.js    # KV memory store
├── test/           # node:test suites + in-memory KV mock
├── .github/workflows/ci.yml
├── wrangler.toml
└── package.json
```

## Deploy

```bash
npx wrangler login
npx wrangler kv namespace create MEMORY_KV            # copy the id into wrangler.toml
npx wrangler kv namespace create MEMORY_KV --preview  # copy into preview_id
# edit or remove the [[routes]] block in wrangler.toml for your own domain
npx wrangler secret put MCP_AUTH_TOKEN                # optional
npm run deploy
```

The `[[routes]]` block in `wrangler.toml` binds the original author's custom domain. Remove it (or replace it with your own route) before deploying; without a route the worker is served at `https://memory-mcp-worker.<your-subdomain>.workers.dev` once `workers.dev` is enabled for it.

## Related projects

- [time-mcp-worker](https://github.com/Kerry1020/time-mcp-worker) — time zone lookup, conversion and time differences
- [geo-mcp-worker](https://github.com/Kerry1020/geo-mcp-worker) — geocoding, POI search and routing via OpenStreetMap services
- [webhook-inbox-mcp-worker](https://github.com/Kerry1020/webhook-inbox-mcp-worker) — receive webhooks into KV and read them as MCP tools
- [summarize-mcp-worker](https://github.com/Kerry1020/summarize-mcp-worker) — web page extraction and extractive summarization
- [image-mcp-worker](https://github.com/Kerry1020/image-mcp-worker) — image generation via any OpenAI-compatible images API
- [calc-mcp-worker](https://github.com/Kerry1020/calc-mcp-worker) — math: expressions, calculus, matrices, statistics
- [search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker) — multi-engine web search with open, auditable ranking

## License

Licensed under the [GNU General Public License v3.0](LICENSE).
