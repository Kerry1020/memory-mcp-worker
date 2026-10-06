// memory-mcp-worker: a Cloudflare Worker exposing KV-backed memory as an MCP server.
//
// Routes
//   GET  /, /healthz   public health / info
//   POST /mcp          MCP JSON-RPC endpoint (optional bearer auth via MCP_AUTH_TOKEN)
//   OPTIONS *          CORS preflight

import { createMcpServer } from "./mcp.js";
import { corsHeaders, isAuthorized, json, unauthorized, withHeaders } from "./http.js";
import { TOOLS, callTool } from "./tools.js";

export const SERVER_NAME = "memory-mcp-worker";
export const SERVER_VERSION = "0.2.0";

const CORS = {
  methods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["content-type", "authorization", "mcp-session-id", "mcp-protocol-version"],
};

const mcp = createMcpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  instructions:
    "Persistent memory store. Use memory_save to remember things, memory_search / memory_list to recall, memory_get for full content.",
  tools: TOOLS,
  callTool,
});

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method === "GET" && (pathname === "/" || pathname === "/healthz")) {
    return json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp_endpoint: `${url.origin}/mcp`,
      storage: "cloudflare_kv",
      auth: env?.MCP_AUTH_TOKEN ? "bearer" : "none",
      tools: TOOLS.map((t) => t.name),
    });
  }

  if (pathname === "/mcp") {
    if (!(await isAuthorized(request, env?.MCP_AUTH_TOKEN))) return unauthorized();
    if (request.method === "POST") return mcp.handleHttp(request, env);
    // No server-initiated SSE stream and no sessions: GET/DELETE are not supported.
    return json({ ok: false, error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      console.error("unhandled error:", err);
      response = json({ ok: false, error: "internal_error" }, 500);
    }
    return withHeaders(response, corsHeaders(env, CORS));
  },
};
