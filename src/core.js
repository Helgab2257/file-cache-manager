/**
 * In-memory cache for file contents with mtime-based invalidation and LRU eviction.
 *
 * Design decisions (documented so the tests are unambiguous):
 *
 * 1. "File" is deliberately abstract. The caller supplies three functions:
 *    - read(path): resolves to a value to cache.
 *    - stat(path): resolves to a numeric mtime (ms since epoch).
 *    - key(path): optional; maps a path to a stable cache key. Defaults to identity.
 *    This avoids any Node `fs` dependency, keeps the module dependency-free, and lets
 *    tests pass fakes that never touch the disk.
 *
 * 2. Cache invalidation compares the stored mtime against the fresh `stat` mtime with a
 *    strict `!==`. Returning the same ms epoch from a fake clock yields equality. We never
 *    round, never compare floats, never use `Date.now`.
 *
 * 3. `get` always re-stats before returning a cached value. This guarantees freshness at
 *    the cost of one `stat` call per `get`. That is the stated trade-off of this library;
 *    if you want speculative TTL caching, this is not the right tool.
 *
 * 4. Size is measured in number of entries, not bytes. Byte-size accounting would require
 *    serializing every value (they may be Buffers, strings, or objects), which is both
 *    expensive and surprising. Counting entries is simple and deterministic.
 *
 * 5. LRU order is tracked with a Map (which preserves insertion order in JS). Access and
 *    write both re-insert the key so it becomes the most-recently-used. Eviction removes
 *    the oldest key by iterating `Map.keys()` once.
 */

/**
 * @typedef {Object} FileCacheOptions
 * @property {(path: string) => Promise<unknown>} read  Reads file contents.
 * @property {(path: string) => Promise<number>} stat   Resolves to the file mtime (ms).
 * @property {(path: string) => string} [key]           Optional key mapper; default identity.
 * @property {number} [maxSize]                         Max entries; default 1000.
 */

/**
 * Internal record describing one cached entry.
 * @typedef {Object} Entry
 * @property {unknown} value
 * @property {number} mtime
 */

/**
 * `Cache miss` is a sentinel returned by `peek` (the non-statting accessor) to distinguish
 * "the value is genuinely undefined/null" from "there is no entry". `get` never returns this
 * sentinel — it resolves to whatever the configured `read` produced.
 */
export const CACHE_MISS = Symbol('file-cache-manager:miss');

export class FileCache {
  /**
   * @param {FileCacheOptions} options
   */
  constructor({ read, stat, key, maxSize } = {}) {
    if (typeof read !== 'function') {
      throw new TypeError('FileCache: `read` must be a function');
    }
    if (typeof stat !== 'function') {
      throw new TypeError('FileCache: `stat` must be a function');
    }
    if (key !== undefined && typeof key !== 'function') {
      throw new TypeError('FileCache: `key` must be a function or undefined');
    }
    const resolvedMax = maxSize === undefined ? 1000 : maxSize;
    if (!Number.isInteger(resolvedMax) || resolvedMax <= 0) {
      throw new TypeError('FileCache: `maxSize` must be a positive integer');
    }

    this._read = read;
    this._stat = stat;
    this._key = key || ((p) => p);
    this._maxSize = resolvedMax;

    /** @type {Map<string, Entry>} */
    this._entries = new Map();

    // Counters exposed via stats() for observability and tests.
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Returns the cached value for `path`, re-stating first to validate freshness.
   *
   * If the path is absent from the cache, or the on-disk mtime has changed, we call `read`,
   * store the result, and return it. Otherwise we return the stored value and touch the
   * entry so it is the most-recently-used.
   *
   * `read` is called at most once per invocation. On a stale entry the old record is fully
   * replaced — we do not keep a stale value around after refreshing.
   *
   * @param {string} path
   * @returns {Promise<unknown>}
   */
  async get(path) {
    const k = this._key(path);
    const freshMtime = await this._stat(path);

    const existing = this._entries.get(k);
    if (existing !== undefined && existing.mtime === freshMtime) {
      this._hits++;
      // Re-insert to mark most-recently-used without duplicating the record.
      this._entries.delete(k);
      this._entries.set(k, existing);
      return existing.value;
    }

    this._misses++;
    const value = await this._read(path);
    this._set(k, value, freshMtime);
    return value;
  }

  /**
   * Returns the cached value for `path` WITHOUT calling `stat` or `read`.
   *
   * This is the only way to inspect the cache without side effects. If the entry is absent
   * (or the entry's value itself was once cached as `undefined`), the `CACHE_MISS` sentinel
   * is returned so callers can distinguish a real miss from a stored undefined.
   *
   * @param {string} path
   * @returns {unknown} The cached value, or `CACHE_MISS`.
   */
  peek(path) {
    const k = this._key(path);
    const entry = this._entries.get(k);
    if (entry === undefined) return CACHE_MISS;
    return entry.value;
  }

  /**
   * Pre-populates the cache with a value and mtime. Does NOT call `read` or `stat` — the
   * caller vouches for the freshness of the supplied mtime. Useful for seeding the cache
   * from a batch loader in tests.
   *
   * @param {string} path
   * @param {unknown} value
   * @param {number} mtime
   * @returns {void}
   */
  prime(path, value, mtime) {
    if (!Number.isFinite(mtime)) {
      throw new TypeError('FileCache.prime: mtime must be a finite number');
    }
    const k = this._key(path);
    this._set(k, value, mtime);
  }

  /**
   * Removes the entry for `path` if present. Returns true if something was deleted.
   * @param {string} path
   * @returns {boolean}
   */
  delete(path) {
    const k = this._key(path);
    return this._entries.delete(k);
  }

  /**
   * Removes every entry.
   * @returns {void}
   */
  clear() {
    this._entries.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Current number of cached entries.
   * @returns {number}
   */
  get size() {
    return this._entries.size;
  }

  /**
   * Snapshot of cache-wide counters.
   * @returns {{size: number, hits: number, misses: number, evictions: number, maxSize: number}}
   */
  stats() {
    return {
      size: this._entries.size,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      maxSize: this._maxSize,
    };
  }

  /**
   * Inserts or replaces an entry, enforcing the size limit by evicting the
   * least-recently-used entries (the oldest keys in insertion order) until we are under the
   * cap. Always counts as a fresh use, so the newly-set key ends up most-recently-used.
   *
   * @param {string} k      already-keyed identifier
   * @param {unknown} value
   * @param {number} mtime
   * @private
   */
  _set(k, value, mtime) {
    // Replacing an existing key first deletes so the subsequent set places it at the end
    // (most-recently-used). Map's insertion-order iteration gives us LRU for free.
    if (this._entries.has(k)) {
      this._entries.delete(k);
    }
    this._entries.set(k, { value, mtime });

    while (this._entries.size > this._maxSize) {
      const oldestKey = this._entries.keys().next().value;
      this._entries.delete(oldestKey);
      this._evictions++;
    }
  }
}
