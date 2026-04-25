# memory-mcp-worker

基于 Cloudflare Worker 的 MCP 服务器，提供简单的 KV 存储记忆操作。通过 JSON-RPC 接口存储、搜索、列表、读取和删除文本记忆。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `memory_save` | 创建或更新记忆（标题、内容、标签、来源）。省略 `id` 创建，包含 `id` 更新。 |
| `memory_list` | 列出最近记忆，可按关键词过滤。 |
| `memory_search` | 全文搜索标题、内容、标签、来源。 |
| `memory_get` | 按 id 读取单条记忆。 |
| `memory_delete` | 按 id 删除单条记忆。 |
| `health` | 健康检查。 |

## 本地开发

```bash
npm install
npx wrangler dev --local --port 8789
```

## 部署

```bash
npx wrangler deploy
```

## 项目结构

```
memory-mcp-worker/
├── src/index.js
├── wrangler.toml
├── package.json
└── README.md
```
