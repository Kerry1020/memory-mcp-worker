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

`GET /healthz` 是 worker 健康检查端点(不是 MCP 工具)。MCP 工具集是上五个。

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

## 工作原理

所有数据存在 Cloudflare KV namespace（绑定名 `MEMORY_KV`）。每条记忆序列化为 JSON，字段：`id`、`title`、`content`、`tags`、`source`、`created_at`、`updated_at`。

MCP 端点遵循标准 JSON-RPC 协议（`/mcp`）。

## 配置

`wrangler.toml` 中必须绑定 KV namespace：

```toml
[[kv_namespaces]]
binding = "MEMORY_KV"
id = "<your-kv-namespace-id>"
```

## 许可证

本项目基于 GNU General Public License v3.0 发布——详见 [LICENSE](LICENSE)。
