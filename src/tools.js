// MCP tool definitions and dispatch for memory-mcp-worker.

import { ToolError } from "./mcp.js";
import { LIMITS, saveMemory, listMemories, getMemory, deleteMemory } from "./store.js";

const idProp = { type: "string", description: "Memory id." };
const limitProp = {
  type: "integer",
  default: LIMITS.listDefault,
  minimum: 1,
  maximum: LIMITS.listMax,
  description: `Maximum number of items to return (1-${LIMITS.listMax}).`,
};

export const TOOLS = [
  {
    name: "memory_save",
    description:
      "Save a note or memory into Cloudflare KV. Creates a new item when id is omitted; updates an existing item when id is provided.",
    inputSchema: {
      type: "object",
      properties: {
        id: { ...idProp, description: "Existing memory id to update, or a custom id for a new memory." },
        title: { type: "string", description: "Short single-line title." },
        content: { type: "string", description: "Memory body. Line breaks are preserved." },
        tags: { type: "array", items: { type: "string" }, description: "Tags (lower-cased, de-duplicated, max 20)." },
        source: { type: "string", description: "Where this memory came from." },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "memory_list",
    description: "List recent memories. Optional keyword will filter results by title/content/tags.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Optional case-insensitive substring filter." },
        limit: limitProp,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_search",
    description: "Search memories by keyword across title, content, tags, and source.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Case-insensitive substring to search for." },
        limit: limitProp,
      },
      required: ["keyword"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_get",
    description: "Read one memory by id.",
    inputSchema: {
      type: "object",
      properties: { id: idProp },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_delete",
    description: "Delete one memory by id.",
    inputSchema: {
      type: "object",
      properties: { id: idProp },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];

export async function callTool(name, args, env) {
  const kv = env?.MEMORY_KV;
  if (!kv) throw new ToolError("missing_kv_binding_MEMORY_KV", "KV binding MEMORY_KV is not configured");
  switch (name) {
    case "memory_save":
      return saveMemory(kv, args);
    case "memory_list":
      return listMemories(kv, args);
    case "memory_search":
      return listMemories(kv, args, { requireKeyword: true });
    case "memory_get":
      return getMemory(kv, args);
    case "memory_delete":
      return deleteMemory(kv, args);
    default:
      throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
  }
}
