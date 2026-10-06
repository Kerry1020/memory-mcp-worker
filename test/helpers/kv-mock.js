// In-memory implementation of the subset of the Cloudflare KV API used by the worker.

export class MemoryKV {
  constructor() {
    this.store = new Map(); // key -> { value, metadata, expiresAt }
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
  }

  #live(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key, options) {
    this.ops.get++;
    const type = typeof options === "string" ? options : options?.type || "text";
    const entry = this.#live(key);
    if (!entry) return null;
    if (type === "json") return JSON.parse(entry.value);
    return entry.value;
  }

  async getWithMetadata(key, options) {
    const value = await this.get(key, options);
    return { value, metadata: value === null ? null : (this.store.get(key)?.metadata ?? null) };
  }

  async put(key, value, options = {}) {
    this.ops.put++;
    if (typeof key !== "string" || !key) throw new Error("KV put: invalid key");
    if (new TextEncoder().encode(key).length > 512) throw new Error("KV put: key too long");
    if (options.metadata !== undefined && JSON.stringify(options.metadata).length > 1024) {
      throw new Error("KV put: metadata too large");
    }
    let expiresAt = null;
    if (options.expirationTtl) {
      if (options.expirationTtl < 60) throw new Error("KV put: expirationTtl must be >= 60");
      expiresAt = Date.now() + options.expirationTtl * 1000;
    } else if (options.expiration) {
      expiresAt = options.expiration * 1000;
    }
    this.store.set(key, {
      value: typeof value === "string" ? value : String(value),
      metadata: options.metadata ?? null,
      expiresAt,
    });
  }

  async delete(key) {
    this.ops.delete++;
    this.store.delete(key);
  }

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    this.ops.list++;
    if (limit < 1 || limit > 1000) throw new Error("KV list: invalid limit");
    let after = null;
    if (cursor) {
      try {
        after = Buffer.from(cursor, "base64url").toString("utf8");
        if (!after.startsWith("c:")) throw new Error();
        after = after.slice(2);
      } catch {
        throw new Error("KV list: invalid cursor");
      }
    }
    const names = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && (after === null || k > after) && this.#live(k))
      .sort();
    const page = names.slice(0, limit);
    const complete = page.length === names.length;
    const keys = page.map((name) => {
      const { metadata, expiresAt } = this.store.get(name);
      const key = { name };
      if (metadata !== null) key.metadata = metadata;
      if (expiresAt) key.expiration = Math.floor(expiresAt / 1000);
      return key;
    });
    const result = { keys, list_complete: complete, cacheStatus: null };
    if (!complete) result.cursor = Buffer.from(`c:${page[page.length - 1]}`).toString("base64url");
    return result;
  }
}
