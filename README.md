# memory-mcp-worker

[![CI](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

A Cloudflare Worker that exposes a small, persistent **memory store** as an [MCP](https://modelcontextprotocol.io) server. AI agents can save, search, list, read and delete text memories; everything is stored in Cloudflare KV.

## Features

- MCP over Streamable HTTP (JSON responses) at `POST /mcp` — no SDK dependencies
- Protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` (negotiated on `initialize`)
- `initialize`, `ping`, `tools/list`, `tools/call`, notifications, JSON-RPC batches
- Tool results include both `content` (text) and `structuredContent`; tool failures are returned with `isError: true`
- Optional bearer-token auth (`MCP_AUTH_TOKEN`), configurable CORS
- Input validation and size limits; recency ordering via KV metadata (no full scan of values)

## MCP Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `memory_save` | `content` (required), `id`, `title`, `tags[]`, `source` | Create a memory (omit `id`) or update one (pass `id`; `created_at` is kept). |
| `memory_list` | `keyword`, `limit` (1-100, default 20) | List most recently updated memories, optionally filtered by keyword. |
| `memory_search` | `keyword` (required), `limit` | Case-insensitive substring search over id, title, content, tags and source. |
| `memory_get` | `id` (required) | Read one memory with full content. |
| `memory_delete` | `id` (required) | Delete one memory. |

`GET /` and `GET /healthz` are public health/info endpoints (not MCP tools).

### Limits

| Field | Limit |
|-------|-------|
| `content` | 100,000 characters (line breaks preserved) |
| `title` | 500 characters (whitespace collapsed) |
| `source` | 200 characters |
| `id` | 128 characters, no control characters |
| `tags` | 20 tags, 64 characters each, lower-cased and de-duplicated |
| request body | 1 MiB |

`memory_list` / `memory_search` consider up to 5,000 keys and fetch up to 500 values per call; `truncated_scan: true` in the result means the limit was hit.

## How It Works

Each memory is stored in the KV namespace bound as `MEMORY_KV` under the key `mem:<id>`. The value is JSON:

```json
{ "id": "m_…", "title": "…", "content": "…", "tags": ["…"], "source": "…", "created_at": "…", "updated_at": "…" }
```

KV metadata `{ updated_at, created_at }` is written alongside, so listing can sort by recency from `KV.list()` alone. Items written by v0.1 (no metadata) are still listed; they are read once per listing to learn their timestamps, and gain metadata the next time they are saved.

KV is eventually consistent (writes can take up to ~60 s to appear in other locations / in `list`) and has no transactions: concurrent updates to the same `id` are last-writer-wins.

## Authentication

Auth is **off by default**. To require a token on `/mcp`:

```bash
npx wrangler secret put MCP_AUTH_TOKEN
```

Clients must then send `Authorization: Bearer <token>`; other requests get `401`. The health endpoints and CORS preflight stay public.

| Variable | Type | Description |
|----------|------|-------------|
| `MCP_AUTH_TOKEN` | secret | Optional. Enables bearer auth on `/mcp`. |
| `CORS_ALLOW_ORIGIN` | var | Optional. `Access-Control-Allow-Origin` value (default `*`). |

## MCP Client Configuration

Clients with native Streamable HTTP support (e.g. Claude Code):

```bash
claude mcp add --transport http memory https://<your-worker>/mcp \
  --header "Authorization: Bearer <token>"   # omit if auth is disabled
```

JSON config (Cursor, Claude Desktop via `mcp-remote`, etc.):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-worker>/mcp", "--header", "Authorization: Bearer ${MEMORY_MCP_TOKEN}"],
      "env": { "MEMORY_MCP_TOKEN": "<token>" }
    }
  }
}
```

## curl Examples

```bash
URL=http://localhost:8789/mcp     # or https://<your-worker>/mcp
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

## Local Development

Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # optional: local secrets
npm run dev                      # http://localhost:8789 (local KV simulation)
npm test                         # node:test suite with an in-memory KV mock
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

## Project Structure

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

## License

This project is licensed under the GNU General Public License v3.0 — see the [LICENSE](LICENSE) file for details.
