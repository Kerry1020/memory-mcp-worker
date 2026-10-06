import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, request, rpc, rpcRaw } from "./helpers/client.js";
import { LATEST_PROTOCOL_VERSION, negotiateProtocolVersion } from "../src/mcp.js";

describe("HTTP routing", () => {
  test("health endpoints", async () => {
    for (const path of ["/", "/healthz"]) {
      const res = await request(makeEnv(), path);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.name, "memory-mcp-worker");
      assert.equal(body.mcp_endpoint, "https://memory.example.test/mcp");
      assert.equal(body.auth, "none");
      assert.deepEqual(body.tools, ["memory_save", "memory_list", "memory_search", "memory_get", "memory_delete"]);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    }
  });

  test("CORS preflight", async () => {
    const res = await request(makeEnv(), "/mcp", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers"), /authorization/);
    assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  });

  test("CORS origin is configurable", async () => {
    const res = await request(makeEnv({ CORS_ALLOW_ORIGIN: "https://app.example" }), "/healthz");
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example");
  });

  test("unknown path is 404", async () => {
    const res = await request(makeEnv(), "/nope");
    assert.equal(res.status, 404);
  });

  test("GET /mcp is 405 (no SSE stream)", async () => {
    const res = await request(makeEnv(), "/mcp");
    assert.equal(res.status, 405);
    assert.match(res.headers.get("allow"), /POST/);
  });
});

describe("JSON-RPC / MCP protocol", () => {
  test("initialize echoes supported protocol version", async () => {
    for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
      const body = await rpc(makeEnv(), "initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } });
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.result.protocolVersion, v);
      assert.ok(body.result.capabilities.tools);
      assert.equal(body.result.serverInfo.name, "memory-mcp-worker");
    }
  });

  test("initialize falls back to latest for unknown versions", async () => {
    const body = await rpc(makeEnv(), "initialize", { protocolVersion: "1999-01-01" });
    assert.equal(body.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
  });

  test("ping returns empty result", async () => {
    const body = await rpc(makeEnv(), "ping");
    assert.deepEqual(body.result, {});
  });

  test("tools/list returns all tools with schemas", async () => {
    const body = await rpc(makeEnv(), "tools/list");
    const names = body.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["memory_save", "memory_list", "memory_search", "memory_get", "memory_delete"]);
    for (const tool of body.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.description, "string");
    }
    const save = body.result.tools[0];
    assert.deepEqual(save.inputSchema.required, ["content"]);
  });

  test("notifications get 202 with no body", async () => {
    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/whatever"]) {
      const res = await rpcRaw(makeEnv(), { jsonrpc: "2.0", method });
      assert.equal(res.status, 202);
      assert.equal(await res.text(), "");
    }
  });

  test("client responses are accepted silently", async () => {
    const res = await rpcRaw(makeEnv(), { jsonrpc: "2.0", id: 5, result: {} });
    assert.equal(res.status, 202);
  });

  test("unknown method is -32601", async () => {
    const body = await rpc(makeEnv(), "resources/list");
    assert.equal(body.error.code, -32601);
  });

  test("parse error is -32700 with null id", async () => {
    const res = await rpcRaw(makeEnv(), "{not json");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32700);
    assert.equal(body.id, null);
  });

  test("invalid requests are -32600", async () => {
    for (const msg of [{ id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: {}, method: "ping" }, 42]) {
      const body = await (await rpcRaw(makeEnv(), msg)).json();
      assert.equal(body.error.code, -32600, JSON.stringify(msg));
    }
  });

  test("non-object params is -32602", async () => {
    const body = await (await rpcRaw(makeEnv(), { jsonrpc: "2.0", id: 1, method: "tools/list", params: [1] })).json();
    assert.equal(body.error.code, -32602);
  });

  test("batch requests", async () => {
    const res = await rpcRaw(makeEnv(), [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const body = await res.json();
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((r) => r.id), [1, 2]);

    const onlyNotifications = await rpcRaw(makeEnv(), [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    assert.equal(onlyNotifications.status, 202);

    const empty = await (await rpcRaw(makeEnv(), [])).json();
    assert.equal(empty.error.code, -32600);
  });

  test("oversized body is rejected", async () => {
    const res = await rpcRaw(makeEnv(), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } }));
    assert.equal(res.status, 413);
  });

  test("tools/call with unknown tool is -32602", async () => {
    const body = await rpc(makeEnv(), "tools/call", { name: "nope", arguments: {} });
    assert.equal(body.error.code, -32602);
  });

  test("tools/call with missing name or bad arguments is -32602", async () => {
    assert.equal((await rpc(makeEnv(), "tools/call", {})).error.code, -32602);
    assert.equal((await rpc(makeEnv(), "tools/call", { name: "memory_list", arguments: [] })).error.code, -32602);
  });

  test("tool errors are reported with isError", async () => {
    const body = await rpc(makeEnv(), "tools/call", { name: "memory_save", arguments: {} });
    assert.equal(body.result.isError, true);
    assert.equal(body.result.structuredContent.error, "content_required");
    assert.equal(JSON.parse(body.result.content[0].text).error, "content_required");
  });

  test("missing KV binding is a tool error", async () => {
    const body = await rpc({}, "tools/call", { name: "memory_list", arguments: {} });
    assert.equal(body.result.isError, true);
    assert.equal(body.result.structuredContent.error, "missing_kv_binding_MEMORY_KV");
  });

  test("unexpected KV failures are reported as internal_error", async () => {
    const env = makeEnv();
    env.MEMORY_KV.list = async () => {
      throw new Error("boom");
    };
    const body = await rpc(env, "tools/call", { name: "memory_list", arguments: {} });
    assert.equal(body.result.isError, true);
    assert.equal(body.result.structuredContent.error, "internal_error");
  });
});

describe("bearer auth", () => {
  const TOKEN = "s3cret-token";

  test("disabled by default", async () => {
    const body = await rpc(makeEnv(), "ping");
    assert.deepEqual(body.result, {});
  });

  test("rejects missing or wrong token when MCP_AUTH_TOKEN is set", async () => {
    const env = makeEnv({ MCP_AUTH_TOKEN: TOKEN });
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }]) {
      const res = await rpcRaw(env, { jsonrpc: "2.0", id: 1, method: "ping" }, headers);
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate"), /Bearer/);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    }
  });

  test("accepts correct token", async () => {
    const env = makeEnv({ MCP_AUTH_TOKEN: TOKEN });
    const res = await rpcRaw(env, { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
  });

  test("health stays public and reports auth mode", async () => {
    const res = await request(makeEnv({ MCP_AUTH_TOKEN: TOKEN }), "/healthz");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).auth, "bearer");
  });

  test("preflight does not require auth", async () => {
    const res = await request(makeEnv({ MCP_AUTH_TOKEN: TOKEN }), "/mcp", { method: "OPTIONS" });
    assert.equal(res.status, 204);
  });
});
