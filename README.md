# memory-mcp-worker

A minimal Cloudflare Worker MCP server for notes / memory storage.

Style matches the simple single-file Worker layout used by `search-mcp-worker` and `plot-mcp-worker`.

## Storage choice

This project uses **Cloudflare KV** because it is the fastest path to a minimal deployable memory MCP:
- simple key/value storage
- no schema migration step
- enough for basic note save / list / search / get / delete

## Included tools

- `memory_save` — create or update one memory
- `memory_list` — list recent memories, optional keyword filter
- `memory_search` — keyword search across title/content/tags/source
- `memory_get` — read one memory by id
- `memory_delete` — delete one memory by id

## Project files

- `package.json`
- `wrangler.toml`
- `src/index.js`
- `README.md`
- `README.zh-CN.md`

## Deploy

1. Create a KV namespace:

```bash
wrangler kv namespace create MEMORY_KV
wrangler kv namespace create MEMORY_KV --preview
```

2. Put the returned namespace ids into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MEMORY_KV"
id = "real-production-id"
preview_id = "real-preview-id"
```

3. Install deps:

```bash
npm install
```

4. Run locally:

```bash
npm run dev
```

5. Deploy:

```bash
npm run deploy
```

## MCP endpoint

After deploy:
- health: `GET /` or `GET /healthz`
- MCP: `POST /mcp`

## Example MCP calls

### initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

### list tools

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

### save memory

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "memory_save",
    "arguments": {
      "title": "Meeting note",
      "content": "User prefers concise answers.",
      "tags": ["preference", "meeting"],
      "source": "manual"
    }
  }
}
```

### search memory

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "keyword": "concise",
      "limit": 10
    }
  }
}
```

## Notes

- Search is implemented by scanning recent KV keys and matching keyword in memory fields.
- This is intentionally minimal and practical, not a full indexed memory engine.
- For larger scale later, you can upgrade to D1 or add embeddings/vector search.
