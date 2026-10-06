// KV-backed memory store.
//
// Layout: one KV key per memory, `mem:<id>`, whose value is the JSON item and
// whose KV metadata is `{ updated_at, created_at }`. The metadata lets list /
// search order items by recency without fetching every value.

import { ToolError } from "./mcp.js";

export const KEY_PREFIX = "mem:";

export const LIMITS = Object.freeze({
  idChars: 128,
  titleChars: 500,
  contentChars: 100_000,
  sourceChars: 200,
  tagChars: 64,
  tags: 20,
  keywordChars: 200,
  listDefault: 20,
  listMax: 100,
  // Upper bounds on KV work per request (Workers allow 1000 KV ops per invocation).
  maxKeysScanned: 5000,
  maxItemsFetched: 500,
});

const FETCH_CONCURRENCY = 50;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const keyFor = (id) => `${KEY_PREFIX}${id}`;
export const stripPrefix = (key) => (key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key);

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Collapse all whitespace runs into single spaces and trim (for single-line fields). */
export function normalizeLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Normalise multi-line text: unify newlines and trim, but keep line breaks and indentation. */
export function normalizeMultiline(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function optionalString(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolError("invalid_argument", `'${field}' must be a string`);
  return value;
}

function checkLength(field, value, max) {
  if (value.length > max) {
    throw new ToolError("invalid_argument", `'${field}' exceeds ${max} characters`, { field, max });
  }
  return value;
}

export function parseId(args, { required }) {
  const id = normalizeLine(optionalString(args, "id"));
  if (!id) {
    if (required) throw new ToolError("id_required", "'id' is required");
    return "";
  }
  checkLength("id", id, LIMITS.idChars);
  if (CONTROL_CHARS.test(id)) throw new ToolError("invalid_argument", "'id' contains control characters");
  return id;
}

export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new ToolError("invalid_argument", "'tags' must be an array of strings");
  }
  const normalized = tags.map((t) => normalizeLine(t).toLowerCase().slice(0, LIMITS.tagChars)).filter(Boolean);
  return [...new Set(normalized)].slice(0, LIMITS.tags);
}

export function makeId() {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `m_${Date.now().toString(36)}_${random}`;
}

export function summarizeItem(item) {
  return {
    id: item.id,
    title: item.title,
    tags: item.tags,
    source: item.source,
    created_at: item.created_at,
    updated_at: item.updated_at,
    preview: String(item.content || "").slice(0, 160),
  };
}

export function includesKeyword(item, keyword) {
  const q = normalizeLine(keyword).toLowerCase();
  if (!q) return true;
  const haystack = [item.id, item.title, item.content, item.source, ...(Array.isArray(item.tags) ? item.tags : [])]
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

function parseItem(raw) {
  try {
    const item = JSON.parse(raw);
    return item && typeof item === "object" ? item : null;
  } catch {
    return null;
  }
}

export async function loadItem(kv, id) {
  const raw = await kv.get(keyFor(id));
  return raw == null ? null : parseItem(raw);
}

async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const results = await Promise.all(chunk.map(fn));
    results.forEach((r, j) => (out[i + j] = r));
  }
  return out;
}

export async function saveMemory(kv, args) {
  const content = normalizeMultiline(optionalString(args, "content"));
  if (!content) throw new ToolError("content_required", "'content' is required");
  checkLength("content", content, LIMITS.contentChars);
  const title = checkLength("title", normalizeLine(optionalString(args, "title")), LIMITS.titleChars);
  const source = checkLength("source", normalizeLine(optionalString(args, "source")), LIMITS.sourceChars);
  const tags = normalizeTags(args.tags);

  const requestedId = parseId(args, { required: false });
  const id = requestedId || makeId();
  // Read-modify-write: KV has no transactions, so concurrent updates of the same
  // id are last-writer-wins. Only created_at is carried over from the old value.
  const existing = requestedId ? await loadItem(kv, id) : null;

  const now = new Date().toISOString();
  const item = {
    id,
    title,
    content,
    tags,
    source,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await kv.put(keyFor(id), JSON.stringify(item), {
    metadata: { updated_at: item.updated_at, created_at: item.created_at },
  });
  return { ok: true, action: existing ? "updated" : "created", item };
}

/** List every `mem:` key (up to LIMITS.maxKeysScanned), following KV cursors. */
async function listAllKeys(kv) {
  const keys = [];
  let cursor;
  let complete = false;
  while (keys.length < LIMITS.maxKeysScanned) {
    const page = await kv.list({
      prefix: KEY_PREFIX,
      cursor,
      limit: Math.min(1000, LIMITS.maxKeysScanned - keys.length),
    });
    keys.push(...(page.keys || []));
    if (page.list_complete || !page.cursor) {
      complete = true;
      break;
    }
    cursor = page.cursor;
  }
  return { keys, complete };
}

export async function listMemories(kv, args, { requireKeyword = false } = {}) {
  const keyword = normalizeLine(optionalString(args, "keyword"));
  if (requireKeyword && !keyword) throw new ToolError("keyword_required", "'keyword' is required");
  checkLength("keyword", keyword, LIMITS.keywordChars);
  const limit = clampInt(args.limit, 1, LIMITS.listMax, LIMITS.listDefault);

  const { keys, complete } = await listAllKeys(kv);
  const cache = new Map();
  let fetchBudget = LIMITS.maxItemsFetched;
  let budgetExhausted = false;

  const fetchItems = async (ids) => {
    const todo = ids.filter((id) => !cache.has(id));
    const allowed = todo.slice(0, Math.max(0, fetchBudget));
    if (allowed.length < todo.length) budgetExhausted = true;
    fetchBudget -= allowed.length;
    const items = await mapConcurrent(allowed, FETCH_CONCURRENCY, (id) => loadItem(kv, id));
    allowed.forEach((id, i) => cache.set(id, items[i]));
  };

  const entries = keys.map((k) => ({ id: stripPrefix(k.name), updated: k.metadata?.updated_at }));

  // Items written by older versions have no metadata; fetch them to learn their timestamps.
  const legacy = entries.filter((e) => !e.updated);
  if (legacy.length) {
    await fetchItems(legacy.map((e) => e.id));
    for (const e of legacy) e.updated = cache.get(e.id)?.updated_at || "";
  }

  entries.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || b.id.localeCompare(a.id));

  let matched;
  let totalMatched;
  if (!keyword) {
    const top = entries.slice(0, limit).map((e) => e.id);
    await fetchItems(top);
    matched = top.map((id) => cache.get(id)).filter(Boolean);
    totalMatched = entries.length;
  } else {
    await fetchItems(entries.map((e) => e.id));
    const all = entries.map((e) => cache.get(e.id)).filter((item) => item && includesKeyword(item, keyword));
    totalMatched = all.length;
    matched = all.slice(0, limit);
  }

  matched.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return {
    ok: true,
    keyword: keyword || null,
    total_matched: totalMatched,
    returned: matched.length,
    items: matched.map(summarizeItem),
    truncated_scan: !complete || budgetExhausted,
  };
}

export async function getMemory(kv, args) {
  const id = parseId(args, { required: true });
  const item = await loadItem(kv, id);
  if (!item) return { ok: false, error: "not_found", id };
  return { ok: true, item };
}

export async function deleteMemory(kv, args) {
  const id = parseId(args, { required: true });
  // Check the raw value so corrupted (unparseable) entries can still be deleted.
  const raw = await kv.get(keyFor(id));
  if (raw == null) return { ok: false, error: "not_found", id };
  await kv.delete(keyFor(id));
  return { ok: true, deleted: true, id };
}
