# file-cache-manager

A small, dependency-free in-memory cache for file contents that invalidates entries when the underlying file's mtime changes and evicts the least-recently-used entry when the cache exceeds a configurable size.

## Usage

```js
import { FileCache } from 'file-cache-manager';
import * as fs from 'node:fs';

const cache = new FileCache({
  read: async (path) => fs.promises.readFile(path, 'utf8'),
  stat: async (path) => (await fs.promises.stat(path)).mtimeMs,
  maxSize: 500,
});

const text = await cache.get('/etc/hosts');
```

`FileCache` is the only class exported. The module also exports the `CACHE_MISS` symbol, which is returned by `peek` when there is no entry to distinguish a genuine miss from a cached `undefined`.

## Why this exists

Reading the same file from disk on every request is wasteful when the file rarely changes. Operating-system page caches help, but they do not let you bound the number of files you keep hot or observe hit/miss statistics. This library provides a bounded, observable cache whose correctness does not depend on the OS.

The trade-off: `get` calls `stat` on every lookup to guarantee freshness. That is one syscall per access, which is cheap relative to a full read but not free. If your workload tolerates stale data, use TTL caching instead; this library deliberately does not.

## The awkward edge

Size is counted in **entries**, not bytes. Byte accounting would require serializing every cached value (which may be a string, a `Buffer`, or an arbitrary object) and would surprise callers who store structured data. If you cache large files, set `maxSize` accordingly — a 10-entry cache can still hold gigabytes.

The `key` option is a footgun: if your key function maps two genuinely different files to the same key, the cache will return whichever value it stored first and never re-read the second file (as long as the mtime matches). The key function is your responsibility; the default is the identity function, which is always safe.
