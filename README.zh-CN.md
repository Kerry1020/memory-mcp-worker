# memory-mcp-worker

[![CI](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml)

[English](README.md) | 简体中文

基于 Cloudflare Worker 的 [MCP](https://modelcontextprotocol.io) 服务器，提供一个小型的持久化**记忆存储**。AI 代理可以保存、搜索、列出、读取和删除文本记忆，数据全部存放在 Cloudflare KV。

## 功能

- 通过 `POST /mcp` 提供 Streamable HTTP（JSON 响应）MCP 服务，无 SDK 依赖
- 支持协议版本 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`（在 `initialize` 时协商）
- 支持 `initialize`、`ping`、`tools/list`、`tools/call`、通知以及 JSON-RPC 批量请求
- 工具结果同时包含 `content`（文本）和 `structuredContent`；工具失败以 `isError: true` 返回
- 可选 Bearer Token 鉴权（`MCP_AUTH_TOKEN`），CORS 来源可配置
- 输入校验与大小限制；通过 KV metadata 按更新时间排序（无需读取全部值）

## MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `memory_save` | `content`（必填）、`id`、`title`、`tags[]`、`source` | 省略 `id` 创建记忆；传入 `id` 更新（保留 `created_at`）。 |
| `memory_list` | `keyword`、`limit`（1-100，默认 20） | 按最近更新时间列出记忆，可按关键词过滤。 |
| `memory_search` | `keyword`（必填）、`limit` | 在 id、标题、内容、标签、来源中做不区分大小写的子串搜索。 |
| `memory_get` | `id`（必填） | 读取单条记忆的完整内容。 |
| `memory_delete` | `id`（必填） | 删除单条记忆。 |

`GET /` 和 `GET /healthz` 是公开的健康检查/信息端点（不是 MCP 工具）。

### 限制

| 字段 | 限制 |
|------|------|
| `content` | 100,000 字符（保留换行） |
| `title` | 500 字符（合并空白） |
| `source` | 200 字符 |
| `id` | 128 字符，不含控制字符 |
| `tags` | 最多 20 个，每个 64 字符，转小写并去重 |
| 请求体 | 1 MiB |

`memory_list` / `memory_search` 每次最多扫描 5,000 个 key、读取 500 个值；结果中 `truncated_scan: true` 表示触达上限。

## 工作原理

每条记忆存放在绑定为 `MEMORY_KV` 的 KV namespace 中，key 为 `mem:<id>`，值为 JSON：

```json
{ "id": "m_…", "title": "…", "content": "…", "tags": ["…"], "source": "…", "created_at": "…", "updated_at": "…" }
```

同时写入 KV metadata `{ updated_at, created_at }`，因此仅凭 `KV.list()` 即可按时间排序。v0.1 写入的旧数据（无 metadata）仍会被列出：列表时会读取一次以获得时间戳，下次保存时自动补上 metadata。

KV 是最终一致的（写入可能需要约 60 秒才在其他节点 / `list` 中可见），且没有事务：对同一 `id` 的并发更新以最后一次写入为准。

## 鉴权

默认**不开启**鉴权。如需为 `/mcp` 启用 Token：

```bash
npx wrangler secret put MCP_AUTH_TOKEN
```

之后客户端必须携带 `Authorization: Bearer <token>`，否则返回 `401`。健康检查端点和 CORS 预检请求保持公开。

| 变量 | 类型 | 说明 |
|------|------|------|
| `MCP_AUTH_TOKEN` | secret | 可选。为 `/mcp` 启用 Bearer 鉴权。 |
| `CORS_ALLOW_ORIGIN` | var | 可选。`Access-Control-Allow-Origin` 的值（默认 `*`）。 |

## MCP 客户端配置

原生支持 Streamable HTTP 的客户端（如 Claude Code）：

```bash
claude mcp add --transport http memory https://<your-worker>/mcp \
  --header "Authorization: Bearer <token>"   # 未启用鉴权可省略
```

JSON 配置（Cursor、通过 `mcp-remote` 的 Claude Desktop 等）：

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

## curl 示例

```bash
URL=http://localhost:8789/mcp     # 或 https://<your-worker>/mcp
AUTH=()                           # 或 AUTH=(-H "Authorization: Bearer $TOKEN")

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_save","arguments":{"title":"部署笔记","content":"使用 wrangler 4。\n每月轮换 token。","tags":["ops"]}}}'

curl -s $URL "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"keyword":"wrangler"}}}'

curl -s http://localhost:8789/healthz
```

## 本地开发

需要 Node.js 20+。

```bash
npm install
cp .dev.vars.example .dev.vars   # 可选：本地 secrets
npm run dev                      # http://localhost:8789（本地模拟 KV）
npm test                         # node:test 测试，使用内存 KV mock
```

## 部署

```bash
npx wrangler login
npx wrangler kv namespace create MEMORY_KV            # 将 id 填入 wrangler.toml
npx wrangler kv namespace create MEMORY_KV --preview  # 填入 preview_id
# 按自己的域名修改或删除 wrangler.toml 中的 [[routes]]
npx wrangler secret put MCP_AUTH_TOKEN                # 可选
npm run deploy
```

## 项目结构

```
memory-mcp-worker/
├── src/
│   ├── index.js    # Worker 入口：路由、CORS、鉴权
│   ├── mcp.js      # JSON-RPC / MCP 协议处理
│   ├── http.js     # HTTP 工具函数（JSON、CORS、请求体限制、Bearer 鉴权）
│   ├── tools.js    # MCP 工具定义与分发
│   └── store.js    # KV 记忆存储
├── test/           # node:test 测试 + 内存 KV mock
├── .github/workflows/ci.yml
├── wrangler.toml
└── package.json
```

## 许可证

本项目基于 GNU General Public License v3.0 发布——详见 [LICENSE](LICENSE)。
