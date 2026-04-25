# memory-mcp-worker

A Cloudflare Worker providing an MCP server for simple KV-backed memory operations. Store, search, list, read, and delete text-based memories via a JSON-RPC interface.

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_save` | Save or update a memory item (title, content, tags, source). Omits `id` to create, includes `id` to update. |
| `memory_list` | List recent memories. Optional keyword filter on title/content/tags. |
| `memory_search` | Full-text search across title, content, tags, and source fields. |
| `memory_get` | Read a single memory by id. |
| `memory_delete` | Delete a single memory by id. |
| `health` | Worker health check. |

## How It Works

All data is stored in a Cloudflare KV namespace bound as `MEMORY_KV`. Each memory item is serialized as JSON with fields: `id`, `title`, `content`, `tags`, `source`, `created_at`, `updated_at`.

The MCP endpoint follows the standard JSON-RPC protocol (`/mcp`).

## Local Development

```bash
npm install
npx wrangler dev --local --port 8789
```

## Deploy

```bash
npx wrangler deploy
```

## Configuration

Required KV namespace binding in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MEMORY_KV"
id = "<your-kv-namespace-id>"
```

## Project Structure

```
memory-mcp-worker/
├── src/index.js      # Worker entry + MCP handlers
├── wrangler.toml     # Cloudflare Worker config
├── package.json
└── README.md
```
