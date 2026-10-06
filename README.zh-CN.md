# memory-mcp-worker

[![CI](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/memory-mcp-worker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)

[English](README.md) | 简体中文

基于 Cloudflare Worker 的 [MCP](https://modelcontextprotocol.io) 服务器，提供一个小巧的持久化记忆存储：Agent 可以保存、搜索、列出、读取和删除文本记忆，数据全部存放在 Cloudflare KV。

## 功能特性

- 五个工具：`memory_save`、`memory_list`、`memory_search`、`memory_get`、`memory_delete`
- 通过 `POST /mcp` 提供 Streamable HTTP（JSON 响应）MCP 服务，不依赖 SDK
- 支持协议版本 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`（在 `initialize` 时协商，不支持的版本回落到最新版）
- 支持 `initialize`、`ping`、`tools/list`、`tools/call`、通知以及 JSON-RPC 批量请求
- 工具结果同时包含 `content`（文本）和 `structuredContent`；工具失败以 `isError: true` 返回
- 可选 Bearer Token 鉴权（`MCP_AUTH_TOKEN`），CORS 来源可配置
- 输入校验与大小限制；借助 KV metadata 按更新时间排序，无需读取全部值

## 快速开始

```bash
git clone https://github.com/Kerry1020/memory-mcp-worker.git
cd memory-mcp-worker
npm install
npm run dev                          # http://localhost:8789，本地模拟 KV
curl -s http://localhost:8789/healthz
```

部署时先创建自己的 KV namespace、设置 Token，再执行 `npm run deploy`（见[部署](#部署)）。之后在 MCP 客户端里填 `https://<your-worker>.workers.dev/mcp` 即可。

## 工具列表

| 工具 | 参数 | 说明 |
|------|------|------|
| `memory_save` | `content`（必填）、`id`、`title`、`tags[]`、`source` | 新建记忆（不传 `id`，或传一个新的自定义 `id`），或覆盖已有记忆（传入其 `id`）。更新时保留 `created_at`，`title` / `tags` / `source` 以本次传入的为准。 |
| `memory_list` | `keyword`、`limit`（1-100，默认 20） | 按最近更新时间列出记忆，可按关键词过滤。 |
| `memory_search` | `keyword`（必填）、`limit`（1-100，默认 20） | 在 id、标题、内容、标签、来源中做不区分大小写的子串搜索。 |
| `memory_get` | `id`（必填） | 读取单条记忆的完整内容。 |
| `memory_delete` | `id`（必填） | 删除单条记忆。 |

`memory_list` 和 `memory_search` 返回摘要（id、标题、标签、来源、时间戳和 160 字符的 `preview`），以及 `total_matched`、`returned`、`truncated_scan`。完整内容请用 `memory_get` 读取。id 不存在时返回 `{ "ok": false, "error": "not_found" }`。

`GET /` 和 `GET /healthz` 是公开的健康检查/信息端点（不是 MCP 工具）。

### 限制

| 字段 | 限制 |
|------|------|
| `content` | 100,000 字符（保留换行） |
| `title` | 500 字符（合并空白） |
| `source` | 200 字符 |
| `id` | 128 字符，不含控制字符 |
| `keyword` | 200 字符 |
| `tags` | 最多 20 个，每个最长 64 字符，转小写并去重（多出的标签丢弃，过长的截断） |
| 请求体 | 1 MiB |

`content`、`title`、`source`、`id`、`keyword` 超长会直接报错。`memory_list` / `memory_search` 每次最多扫描 5,000 个 key、读取 500 个值；结果中 `truncated_scan: true` 表示触达了上限。

## 工作原理

每条记忆存放在绑定为 `MEMORY_KV` 的 KV namespace 中，key 为 `mem:<id>`，值为 JSON：

```json
{ "id": "m_…", "title": "…", "content": "…", "tags": ["…"], "source": "…", "created_at": "…", "updated_at": "…" }
```

同时写入 KV metadata `{ updated_at, created_at }`，因此仅凭 `KV.list()` 即可按时间排序。v0.1 写入的旧数据（无 metadata）仍会被列出：列表时会读取一次以获得时间戳，下次保存时自动补上 metadata。

KV 是最终一致的（写入可能需要约 60 秒才在其他节点 / `list` 中可见），且没有事务：对同一 `id` 的并发更新以最后一次写入为准。

## 配置

| 名称 | 必填 | Secret | 默认值 | 说明 |
|------|------|--------|--------|------|
| `MEMORY_KV` | 是 | 否 | 无 | 存放记忆的 KV namespace 绑定，在 `wrangler.toml` 中配置 `id` / `preview_id`。缺少时所有工具调用都会返回 `missing_kv_binding_MEMORY_KV`。 |
| `MCP_AUTH_TOKEN` | 否（强烈建议） | 是 | 不设置 | 设置后，所有 `/mcp` 请求都必须带 `Authorization: Bearer <token>`，否则返回 `401`。 |
| `CORS_ALLOW_ORIGIN` | 否 | 否 | `*` | 所有响应中 `Access-Control-Allow-Origin` 的值。 |

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars`（已加入 .gitignore）再填值。

## MCP 客户端配置

Claude Code（原生支持 Streamable HTTP）：

```bash
claude mcp add --transport http memory https://<your-worker>.workers.dev/mcp

# Worker 设置了 MCP_AUTH_TOKEN 时
claude mcp add --transport http memory https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude Desktop、Cursor 等只支持 stdio 的客户端，通过 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 接入：

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

未启用鉴权时，去掉 `--header` 两个参数和 `env` 即可。

## curl 示例

```bash
URL=http://localhost:8789/mcp     # 或 https://<your-worker>.workers.dev/mcp
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

## 安全说明

- 默认**不开启**鉴权。不设置 `MCP_AUTH_TOKEN` 时，任何知道地址的人都能读取、覆盖、删除所有记忆。公开部署请务必设置 Token：
  ```bash
  npx wrangler secret put MCP_AUTH_TOKEN
  ```
  Token 比较采用常量时间（比较 SHA-256 摘要）。
- `GET /`、`GET /healthz` 和 `OPTIONS` 预检始终无需鉴权。健康检查只返回服务名、版本、工具列表以及是否启用了鉴权（`"auth": "bearer"` 或 `"none"`），不会返回任何记忆数据。
- CORS 默认为 `*`。如果只允许某个来源的浏览器访问，请设置 `CORS_ALLOW_ORIGIN`。这只是浏览器侧的限制，不能当作访问控制。
- 超过 1 MiB 的请求体会被拒绝；未处理的异常只返回通用的 `internal_error`，不暴露堆栈。
- 记忆以明文 JSON 存在你的 KV namespace 里，不适合放进 KV 的机密信息就别存。

## 开发

需要 Node.js 20+。

```bash
npm install
cp .dev.vars.example .dev.vars   # 可选：本地 secrets
npm run dev                      # wrangler dev，http://localhost:8789（本地模拟 KV）
npm test                         # node:test 测试，使用内存 KV mock
npm run build                    # wrangler dry-run 打包到 dist/
```

### 项目结构

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

## 部署

```bash
npx wrangler login
npx wrangler kv namespace create MEMORY_KV            # 将 id 填入 wrangler.toml
npx wrangler kv namespace create MEMORY_KV --preview  # 填入 preview_id
# 按自己的域名修改或删除 wrangler.toml 中的 [[routes]]
npx wrangler secret put MCP_AUTH_TOKEN                # 可选
npm run deploy
```

`wrangler.toml` 里的 `[[routes]]` 绑定的是原作者的自定义域名。部署前请删掉它（或换成你自己的路由）；没有路由时，只要为该 Worker 启用了 `workers.dev`，就可以通过 `https://memory-mcp-worker.<your-subdomain>.workers.dev` 访问。

## 相关项目

- [time-mcp-worker](https://github.com/Kerry1020/time-mcp-worker) — 时区查询、时间换算与时间差计算
- [geo-mcp-worker](https://github.com/Kerry1020/geo-mcp-worker) — 基于 OpenStreetMap 的地理编码、周边 POI 搜索与路线规划
- [webhook-inbox-mcp-worker](https://github.com/Kerry1020/webhook-inbox-mcp-worker) — 把 Webhook 收进 KV，再通过 MCP 工具读取
- [summarize-mcp-worker](https://github.com/Kerry1020/summarize-mcp-worker) — 网页正文提取与抽取式摘要
- [image-mcp-worker](https://github.com/Kerry1020/image-mcp-worker) — 对接任意 OpenAI 兼容图像接口生成图片
- [calc-mcp-worker](https://github.com/Kerry1020/calc-mcp-worker) — 数学计算：表达式、微积分、矩阵、统计
- [search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker) — 多引擎网页搜索，排序逻辑公开可审计

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE) 许可证。
