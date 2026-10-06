import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, callTool, rpc } from "./helpers/client.js";
import { keyFor, LIMITS } from "../src/store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("memory_save", () => {
  test("creates an item with generated id", async () => {
    const env = makeEnv();
    const { data, result } = await callTool(env, "memory_save", {
      title: "  Hello   world ",
      content: "line one\r\n  line two  ",
      tags: ["A", "a", " b ", ""],
      source: "test",
    });
    assert.equal(result.isError, undefined);
    assert.equal(data.ok, true);
    assert.equal(data.action, "created");
    assert.match(data.item.id, /^m_[0-9a-z]+_[0-9a-f]{12}$/);
    assert.equal(data.item.title, "Hello world");
    assert.equal(data.item.content, "line one\n  line two", "line breaks and indentation preserved");
    assert.deepEqual(data.item.tags, ["a", "b"]);
    assert.equal(data.item.created_at, data.item.updated_at);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse(result.content[0].text), data);

    const stored = env.MEMORY_KV.store.get(keyFor(data.item.id));
    assert.deepEqual(JSON.parse(stored.value), data.item);
    assert.deepEqual(stored.metadata, { updated_at: data.item.updated_at, created_at: data.item.created_at });
  });

  test("updates an existing item and keeps created_at", async () => {
    const env = makeEnv();
    const first = (await callTool(env, "memory_save", { content: "v1" })).data.item;
    await sleep(5);
    const { data } = await callTool(env, "memory_save", { id: first.id, content: "v2" });
    assert.equal(data.action, "updated");
    assert.equal(data.item.created_at, first.created_at);
    assert.notEqual(data.item.updated_at, first.updated_at);
    assert.equal(data.item.content, "v2");
  });

  test("custom id creates a new item", async () => {
    const env = makeEnv();
    const { data } = await callTool(env, "memory_save", { id: "project-notes", content: "x" });
    assert.equal(data.action, "created");
    assert.equal(data.item.id, "project-notes");
  });

  test("validates input", async () => {
    const env = makeEnv();
    const cases = [
      [{}, "content_required"],
      [{ content: "   " }, "content_required"],
      [{ content: 123 }, "invalid_argument"],
      [{ content: "x", title: {} }, "invalid_argument"],
      [{ content: "x", tags: "a,b" }, "invalid_argument"],
      [{ content: "x", tags: [1] }, "invalid_argument"],
      [{ content: "x", id: "a".repeat(LIMITS.idChars + 1) }, "invalid_argument"],
      [{ content: "x".repeat(LIMITS.contentChars + 1) }, "invalid_argument"],
      [{ content: "x", title: "t".repeat(LIMITS.titleChars + 1) }, "invalid_argument"],
    ];
    for (const [args, code] of cases) {
      const { result, data } = await callTool(env, "memory_save", args);
      assert.equal(result.isError, true, JSON.stringify(args).slice(0, 80));
      assert.equal(data.error, code);
    }
    assert.equal(env.MEMORY_KV.store.size, 0);
  });

  test("caps tags at 20", async () => {
    const tags = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const { data } = await callTool(makeEnv(), "memory_save", { content: "x", tags });
    assert.equal(data.item.tags.length, 20);
  });
});

describe("memory_get / memory_delete", () => {
  test("get returns item, delete removes it", async () => {
    const env = makeEnv();
    const item = (await callTool(env, "memory_save", { content: "hello" })).data.item;
    assert.deepEqual((await callTool(env, "memory_get", { id: item.id })).data, { ok: true, item });
    assert.deepEqual((await callTool(env, "memory_delete", { id: item.id })).data, { ok: true, deleted: true, id: item.id });
    assert.deepEqual((await callTool(env, "memory_get", { id: item.id })).data, { ok: false, error: "not_found", id: item.id });
    assert.deepEqual((await callTool(env, "memory_delete", { id: item.id })).data, { ok: false, error: "not_found", id: item.id });
  });

  test("id is required", async () => {
    for (const name of ["memory_get", "memory_delete"]) {
      const { result, data } = await callTool(makeEnv(), name, {});
      assert.equal(result.isError, true);
      assert.equal(data.error, "id_required");
    }
  });

  test("corrupted values read as not found but can be deleted", async () => {
    const env = makeEnv();
    await env.MEMORY_KV.put(keyFor("bad"), "{oops");
    assert.equal((await callTool(env, "memory_get", { id: "bad" })).data.error, "not_found");
    assert.equal((await callTool(env, "memory_delete", { id: "bad" })).data.deleted, true);
    assert.equal(env.MEMORY_KV.store.size, 0);
  });
});

describe("memory_list / memory_search", () => {
  async function seed(env, n, makeArgs = (i) => ({ content: `note ${i}` })) {
    const items = [];
    for (let i = 0; i < n; i++) {
      items.push((await callTool(env, "memory_save", makeArgs(i))).data.item);
      await sleep(2);
    }
    return items;
  }

  test("lists newest first with summaries", async () => {
    const env = makeEnv();
    const items = await seed(env, 3);
    const { data } = await callTool(env, "memory_list", {});
    assert.equal(data.ok, true);
    assert.equal(data.keyword, null);
    assert.equal(data.total_matched, 3);
    assert.equal(data.returned, 3);
    assert.equal(data.truncated_scan, false);
    assert.deepEqual(data.items.map((i) => i.id), items.map((i) => i.id).reverse());
    assert.deepEqual(Object.keys(data.items[0]).sort(), ["created_at", "id", "preview", "source", "tags", "title", "updated_at"]);
  });

  test("updated items move to the top", async () => {
    const env = makeEnv();
    const items = await seed(env, 3);
    await callTool(env, "memory_save", { id: items[0].id, content: "edited" });
    const { data } = await callTool(env, "memory_list", { limit: 1 });
    assert.equal(data.items[0].id, items[0].id);
    assert.equal(data.total_matched, 3);
    assert.equal(data.returned, 1);
  });

  test("limit is clamped", async () => {
    const env = makeEnv();
    await seed(env, 3);
    assert.equal((await callTool(env, "memory_list", { limit: 0 })).data.returned, 1);
    assert.equal((await callTool(env, "memory_list", { limit: "2" })).data.returned, 2);
    assert.equal((await callTool(env, "memory_list", { limit: "abc" })).data.returned, 3);
  });

  test("regression: newest items are listed even with more than 200 stored", async () => {
    const env = makeEnv();
    // Simulate 250 old items quickly via direct KV writes with ordered timestamps.
    const base = Date.parse("2025-01-01T00:00:00Z");
    for (let i = 0; i < 250; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      const id = `m_${(base + i * 1000).toString(36)}_${String(i).padStart(12, "0")}`;
      const item = { id, title: "", content: `old ${i}`, tags: [], source: "", created_at: ts, updated_at: ts };
      await env.MEMORY_KV.put(keyFor(id), JSON.stringify(item), { metadata: { updated_at: ts, created_at: ts } });
    }
    const fresh = (await callTool(env, "memory_save", { content: "brand new" })).data.item;
    const { data } = await callTool(env, "memory_list", { limit: 5 });
    assert.equal(data.items[0].id, fresh.id);
    assert.equal(data.items[1].preview, "old 249");
    assert.equal(data.total_matched, 251);
    assert.equal(data.truncated_scan, false);
    // Listing without a keyword only fetches the values it returns.
    env.MEMORY_KV.ops.get = 0;
    await callTool(env, "memory_list", { limit: 5 });
    assert.equal(env.MEMORY_KV.ops.get, 5);
    const search = (await callTool(env, "memory_search", { keyword: "brand" })).data;
    assert.equal(search.total_matched, 1);
    assert.equal(search.items[0].id, fresh.id);
  });

  test("follows KV list cursors beyond 1000 keys", async () => {
    const env = makeEnv();
    const ts = "2025-01-01T00:00:00.000Z";
    for (let i = 0; i < 1100; i++) {
      const id = `k${String(i).padStart(5, "0")}`;
      await env.MEMORY_KV.put(keyFor(id), JSON.stringify({ id, content: "c", updated_at: ts }), { metadata: { updated_at: ts } });
    }
    const { data } = await callTool(env, "memory_list", { limit: 1 });
    assert.equal(data.total_matched, 1100);
    assert.equal(data.items[0].id, "k01099");
  });

  test("handles legacy items without metadata", async () => {
    const env = makeEnv();
    const legacy = { id: "legacy", title: "Old", content: "from v0.1", tags: ["x"], source: "", created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:00.000Z" };
    await env.MEMORY_KV.put(keyFor("legacy"), JSON.stringify(legacy));
    await callTool(env, "memory_save", { content: "new" });
    const { data } = await callTool(env, "memory_list", {});
    assert.equal(data.items[0].id, "legacy", "ordered by stored updated_at");
    assert.equal(data.total_matched, 2);
  });

  test("search matches title, content, tags, source and id; case-insensitive", async () => {
    const env = makeEnv();
    await callTool(env, "memory_save", { title: "Alpha", content: "one" });
    await callTool(env, "memory_save", { content: "contains BETA text" });
    await callTool(env, "memory_save", { content: "three", tags: ["gamma"] });
    await callTool(env, "memory_save", { content: "four", source: "Delta-app" });
    await callTool(env, "memory_save", { id: "epsilon-id", content: "five" });
    for (const q of ["alpha", "beta", "GAMMA", "delta", "epsilon"]) {
      const { data } = await callTool(env, "memory_search", { keyword: q });
      assert.equal(data.total_matched, 1, q);
      assert.equal(data.keyword, q);
    }
    assert.equal((await callTool(env, "memory_list", { keyword: "beta" })).data.returned, 1);
  });

  test("search requires keyword", async () => {
    for (const args of [{}, { keyword: "  " }]) {
      const { result, data } = await callTool(makeEnv(), "memory_search", args);
      assert.equal(result.isError, true);
      assert.equal(data.error, "keyword_required");
    }
  });

  test("corrupted values are skipped in listings", async () => {
    const env = makeEnv();
    await env.MEMORY_KV.put(keyFor("bad"), "{oops");
    await callTool(env, "memory_save", { content: "good" });
    const { data } = await callTool(env, "memory_list", {});
    assert.equal(data.returned, 1);
  });
});

test("tools/call results always include text content", async () => {
  const body = await rpc(makeEnv(), "tools/call", { name: "memory_list" });
  assert.equal(body.result.content[0].type, "text");
  assert.equal(body.result.structuredContent.ok, true);
});
