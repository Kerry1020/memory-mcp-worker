const SERVER_NAME = 'memory-mcp-worker';
const SERVER_VERSION = '0.1.0';
const KEY_PREFIX = 'mem:';
const MAX_LIST_LIMIT = 100;
const MAX_SEARCH_SCAN = 200;

const TOOLS = [
  {
    name: 'memory_save',
    description: 'Save a note or memory into Cloudflare KV. Creates a new item when id is omitted; updates an existing item when id is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' }
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_list',
    description: 'List recent memories. Optional keyword will filter results by title/content/tags.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        limit: { type: 'integer', default: 20 }
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: 'Search memories by keyword across title, content, tags, and source.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        limit: { type: 'integer', default: 20 }
      },
      required: ['keyword'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    description: 'Read one memory by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete one memory by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function corsHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, mcp-session-id',
    ...extra,
  };
}

function jsonRpc(id, result) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: corsHeaders() });
}

function jsonRpcError(id, code, message, data) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message, data } }, { headers: corsHeaders() });
}

function textContent(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((x) => normalizeText(x).toLowerCase()).filter(Boolean))].slice(0, 20);
}

function makeId() {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `m_${Date.now().toString(36)}_${random}`;
}

function keyFor(id) {
  return `${KEY_PREFIX}${id}`;
}

function stripPrefix(key = '') {
  return String(key).startsWith(KEY_PREFIX) ? String(key).slice(KEY_PREFIX.length) : String(key);
}

function summarizeItem(item) {
  return {
    id: item.id,
    title: item.title,
    tags: item.tags,
    source: item.source,
    created_at: item.created_at,
    updated_at: item.updated_at,
    preview: String(item.content || '').slice(0, 160),
  };
}

function includesKeyword(item, keyword) {
  const q = normalizeText(keyword).toLowerCase();
  if (!q) return true;
  const hay = [
    item.id,
    item.title,
    item.content,
    item.source,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].join('\n').toLowerCase();
  return hay.includes(q);
}

async function loadItem(env, id) {
  const raw = await env.MEMORY_KV.get(keyFor(id));
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveMemory(env, args) {
  const now = new Date().toISOString();
  const content = normalizeText(args?.content);
  if (!content) throw new Error('content_required');

  const requestedId = normalizeText(args?.id);
  const id = requestedId || makeId();
  const existing = requestedId ? await loadItem(env, id) : null;

  const item = {
    id,
    title: normalizeText(args?.title),
    content,
    tags: normalizeTags(args?.tags),
    source: normalizeText(args?.source),
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await env.MEMORY_KV.put(keyFor(id), JSON.stringify(item));
  return {
    ok: true,
    action: existing ? 'updated' : 'created',
    item,
  };
}

async function listMemories(env, args, requireKeyword = false) {
  const keyword = normalizeText(args?.keyword);
  if (requireKeyword && !keyword) throw new Error('keyword_required');

  const limit = clampInt(args?.limit, 1, MAX_LIST_LIMIT, 20);
  const listed = await env.MEMORY_KV.list({ prefix: KEY_PREFIX, limit: MAX_SEARCH_SCAN });
  const ids = (listed.keys || []).map((k) => stripPrefix(k.name));
  const items = [];

  for (const id of ids) {
    const item = await loadItem(env, id);
    if (!item) continue;
    if (!includesKeyword(item, keyword)) continue;
    items.push(item);
  }

  items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const sliced = items.slice(0, limit);

  return {
    ok: true,
    keyword: keyword || null,
    total_matched: items.length,
    returned: sliced.length,
    items: sliced.map(summarizeItem),
    truncated_scan: (listed.keys || []).length >= MAX_SEARCH_SCAN,
  };
}

async function getMemory(env, args) {
  const id = normalizeText(args?.id);
  if (!id) throw new Error('id_required');
  const item = await loadItem(env, id);
  if (!item) return { ok: false, error: 'not_found', id };
  return { ok: true, item };
}

async function deleteMemory(env, args) {
  const id = normalizeText(args?.id);
  if (!id) throw new Error('id_required');
  const existing = await loadItem(env, id);
  if (!existing) return { ok: false, error: 'not_found', id };
  await env.MEMORY_KV.delete(keyFor(id));
  return { ok: true, deleted: true, id };
}

async function handleToolCall(name, args, env) {
  if (!env?.MEMORY_KV) throw new Error('missing_kv_binding_MEMORY_KV');

  switch (name) {
    case 'memory_save':
      return await saveMemory(env, args);
    case 'memory_list':
      return await listMemories(env, args, false);
    case 'memory_search':
      return await listMemories(env, args, true);
    case 'memory_get':
      return await getMemory(env, args);
    case 'memory_delete':
      return await deleteMemory(env, args);
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
      return Response.json({
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_endpoint: `${url.origin}/mcp`,
        storage: 'cloudflare_kv',
        tools: TOOLS.map((t) => t.name),
      }, { headers: corsHeaders() });
    }

    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: corsHeaders() });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }

    const id = body?.id ?? null;
    const method = body?.method;
    const params = body?.params || {};

    try {
      if (method === 'initialize') {
        return jsonRpc(id, {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }

      if (method === 'notifications/initialized') {
        return new Response(null, { status: 202, headers: corsHeaders() });
      }

      if (method === 'tools/list') {
        return jsonRpc(id, { tools: TOOLS });
      }

      if (method === 'tools/call') {
        const result = await handleToolCall(params?.name, params?.arguments || {}, env);
        return jsonRpc(id, textContent(result));
      }

      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (e) {
      return jsonRpcError(id, -32000, 'Tool execution failed', { message: String(e?.message || e) });
    }
  },
};
