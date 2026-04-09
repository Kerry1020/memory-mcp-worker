# memory-mcp-worker

一个最小可用的 Cloudflare Worker MCP 服务，用来保存和管理 note / memory。

整体风格参考 `search-mcp-worker` 与 `plot-mcp-worker`：
- 单 Worker
- 单入口 `src/index.js`
- 直接暴露 `/mcp`
- 结构简单，便于马上改和马上部署

## 存储方案

本项目选择 **Cloudflare KV**，原因是它是当前最快能落地的方案：
- 不需要建表和迁移
- 非常适合最小版 note / memory 存储
- 足够支持保存、列出、搜索、读取、删除

## 已实现的 MCP 工具

- `memory_save`：保存一条 memory；传 `id` 时更新，不传时新建
- `memory_list`：列出最近的 memory，可选 `keyword` 过滤
- `memory_search`：按关键词搜索 title/content/tags/source
- `memory_get`：按 id 读取单条
- `memory_delete`：按 id 删除单条

## 项目文件

- `package.json`
- `wrangler.toml`
- `src/index.js`
- `README.md`
- `README.zh-CN.md`

## 部署步骤

### 1）创建 KV namespace

```bash
wrangler kv namespace create MEMORY_KV
wrangler kv namespace create MEMORY_KV --preview
```

### 2）把返回的 namespace id 填进 `wrangler.toml`

```toml
[[kv_namespaces]]
binding = "MEMORY_KV"
id = "你的生产环境 namespace id"
preview_id = "你的预览环境 namespace id"
```

### 3）安装依赖

```bash
npm install
```

### 4）本地启动

```bash
npm run dev
```

### 5）部署

```bash
npm run deploy
```

## 接口说明

部署后可用：
- 健康检查：`GET /` 或 `GET /healthz`
- MCP 入口：`POST /mcp`

## 示例

### 保存一条 memory

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "memory_save",
    "arguments": {
      "title": "会议记录",
      "content": "用户偏好简洁回复。",
      "tags": ["偏好", "会议"],
      "source": "manual"
    }
  }
}
```

### 搜索 memory

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": {
      "keyword": "简洁",
      "limit": 10
    }
  }
}
```

## 说明

- 当前搜索实现方式是：扫描最近一批 KV key，再对 title/content/tags/source 做关键词匹配。
- 这版是“最小可用”，重点是先能落地、能部署、能给 MCP 客户端直接用。
- 后续如果你要更强的检索能力，可以升级到 D1、向量检索，或者加独立索引。
