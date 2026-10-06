import worker from "../../src/index.js";
import { MemoryKV } from "./kv-mock.js";

export const BASE = "https://memory.example.test";

export function makeEnv(extra = {}) {
  return { MEMORY_KV: new MemoryKV(), ...extra };
}

export function request(env, path, init = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, init), env);
}

export async function rpcRaw(env, body, headers = {}) {
  return request(env, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let nextId = 1;
export async function rpc(env, method, params, headers) {
  const res = await rpcRaw(env, { jsonrpc: "2.0", id: nextId++, method, params }, headers);
  return res.json();
}

/** Call a tool and return { result, data } where data is structuredContent. */
export async function callTool(env, name, args = {}) {
  const body = await rpc(env, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc error ${body.error.code}: ${body.error.message}`);
  return { result: body.result, data: body.result.structuredContent };
}
