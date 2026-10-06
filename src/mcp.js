// Minimal, dependency-free MCP server over Streamable HTTP (JSON responses only).
//
// Implements the JSON-RPC 2.0 subset MCP needs for a tools-only server:
//   initialize, ping, tools/list, tools/call, and notifications.
// Batches (JSON arrays) are accepted for clients on protocol 2025-03-26.

import { readBodyText, json, PayloadTooLargeError } from "./http.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const ErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * An error raised by a tool handler that should be reported to the model as a
 * tool execution error (`isError: true`) rather than a protocol error.
 */
export class ToolError extends Error {
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/** Wrap a JSON-serialisable value as an MCP tool result. */
export function toolResult(data, { isError = false } = {}) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
  // structuredContent must be a JSON object.
  if (data && typeof data === "object" && !Array.isArray(data)) result.structuredContent = data;
  if (isError) result.isError = true;
  return result;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isValidId = (id) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.version
 * @param {string} [options.instructions]
 * @param {Array<object>} options.tools  MCP tool definitions
 * @param {(name: string, args: object, env: object) => Promise<any>} options.callTool
 * @param {number} [options.maxBodyBytes]
 */
export function createMcpServer({ name, version, instructions, tools, callTool, maxBodyBytes = 1024 * 1024 }) {
  const toolNames = new Set(tools.map((t) => t.name));

  async function handleToolsCall(id, params, env) {
    const toolName = params.name;
    if (typeof toolName !== "string" || !toolName) {
      return rpcError(id, ErrorCode.INVALID_PARAMS, "Invalid params: 'name' must be a non-empty string");
    }
    if (!toolNames.has(toolName)) {
      return rpcError(id, ErrorCode.INVALID_PARAMS, `Unknown tool: ${toolName}`);
    }
    const args = params.arguments ?? {};
    if (!isPlainObject(args)) {
      return rpcError(id, ErrorCode.INVALID_PARAMS, "Invalid params: 'arguments' must be an object");
    }
    try {
      return rpcResult(id, toolResult(await callTool(toolName, args, env)));
    } catch (err) {
      if (err instanceof ToolError) {
        const payload = { ok: false, error: err.code, message: err.message };
        if (err.details !== undefined) payload.details = err.details;
        return rpcResult(id, toolResult(payload, { isError: true }));
      }
      console.error(`tool ${toolName} failed:`, err);
      return rpcResult(
        id,
        toolResult({ ok: false, error: "internal_error", message: String(err?.message || err) }, { isError: true }),
      );
    }
  }

  /** Handle one JSON-RPC message. Returns a response object, or null when no response is due. */
  async function handleMessage(msg, env) {
    if (!isPlainObject(msg)) return rpcError(null, ErrorCode.INVALID_REQUEST, "Invalid Request");

    const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
    // A JSON-RPC response sent by the client (e.g. to a server request): nothing to reply.
    if (!("method" in msg) && ("result" in msg || "error" in msg)) return null;

    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || (hasId && !isValidId(msg.id))) {
      return rpcError(isValidId(msg.id) ? msg.id : null, ErrorCode.INVALID_REQUEST, "Invalid Request");
    }

    // Notifications (no id) never get a response, whatever the method.
    if (!hasId) return null;

    const { id, method } = msg;
    const params = msg.params ?? {};
    if (!isPlainObject(params)) {
      return rpcError(id, ErrorCode.INVALID_PARAMS, "Invalid params: 'params' must be an object");
    }

    switch (method) {
      case "initialize": {
        const result = {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        };
        if (instructions) result.instructions = instructions;
        return rpcResult(id, result);
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools });
      case "tools/call":
        return handleToolsCall(id, params, env);
      default:
        return rpcError(id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** Handle a POST to the MCP endpoint. */
  async function handleHttp(request, env) {
    let body;
    try {
      body = JSON.parse(await readBodyText(request, maxBodyBytes));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return json(rpcError(null, ErrorCode.INVALID_REQUEST, "Request body too large"), 413);
      }
      return json(rpcError(null, ErrorCode.PARSE_ERROR, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      if (body.length === 0) return json(rpcError(null, ErrorCode.INVALID_REQUEST, "Invalid Request"), 400);
      const responses = (await Promise.all(body.map((m) => handleMessage(m, env)))).filter(Boolean);
      return responses.length ? json(responses) : new Response(null, { status: 202 });
    }

    const response = await handleMessage(body, env);
    return response ? json(response) : new Response(null, { status: 202 });
  }

  return { handleMessage, handleHttp };
}
