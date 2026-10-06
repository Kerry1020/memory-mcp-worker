// HTTP helpers shared by the worker: JSON responses, CORS, body limits, bearer auth.

export class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`payload_too_large: limit is ${limit} bytes`);
    this.name = "PayloadTooLargeError";
    this.limit = limit;
  }
}

const encoder = new TextEncoder();

export function byteLength(str) {
  return encoder.encode(str).length;
}

export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function corsHeaders(env, { methods, allowHeaders }) {
  return {
    "access-control-allow-origin": env?.CORS_ALLOW_ORIGIN || "*",
    "access-control-allow-methods": methods.join(", "),
    "access-control-allow-headers": allowHeaders.join(", "),
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
    "access-control-max-age": "86400",
  };
}

/** Return a copy of `response` with the given headers added. */
export function withHeaders(response, headers) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

/** Read the request body as text, rejecting bodies larger than `maxBytes`. */
export async function readBodyText(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes);
  const text = await request.text();
  if (byteLength(text) > maxBytes) throw new PayloadTooLargeError(maxBytes);
  return text;
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(str)));
}

/** Constant-time string comparison (compares SHA-256 digests). */
export async function safeEqual(a, b) {
  const [da, db] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Check `Authorization: Bearer <token>` against `expected`.
 * When `expected` is empty/undefined, auth is disabled and every request passes.
 */
export async function isAuthorized(request, expected) {
  if (!expected) return true;
  const token = bearerToken(request);
  return token !== null && (await safeEqual(token, expected));
}

export function unauthorized() {
  return json({ ok: false, error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="mcp"' });
}
