// fake-fs.js — runs in the BROWSER as a Playwright init script.
//
// Replaces two browser surfaces so GitQi believes it has folder access
// without ever touching the real OS filesystem:
//
//   1. window.showDirectoryPicker()
//      Returns an in-memory FileSystemDirectoryHandle backed by a Map<path, bytes>.
//
//   2. indexedDB.open('__gitqi_fs', ...)
//      GitQi persists the handle across reloads via IDB. Real IDB can't
//      structured-clone our fake (functions don't survive). We intercept
//      this specific DB and store the handle in a JS Map instead. Other
//      IDB usage falls through to the real implementation.
//
// What stays REAL: every other browser API GitQi uses — DOM, contenteditable,
// MutationObserver, blob URLs, fetch (mocks live in api-mocks.js), undo
// snapshotting, serialization. Only the disk + handle-persistence boundary
// is faked.
//
// Test-side hooks exposed on `window`:
//   window.__fakeDisk.read(path)     — string contents of a file, or null
//   window.__fakeDisk.readBytes(p)   — number[] (Array.from(Uint8Array))
//   window.__fakeDisk.list()         — sorted array of all paths
//   window.__fakeDisk.has(path)      — boolean
//   window.__fakeDisk.write(p, str)  — seed/overwrite a file from the test
//   window.__fakeDisk.delete(path)
//   window.__fakeDisk.clear()
//   window.__seedFakeDisk(obj)       — { "path": "contents", ... }

(function () {
  if (window.__fakeDisk) return; // idempotent — init script may run twice on reload

  // ── In-memory "disk" ─────────────────────────────────────────────────────
  const store = new Map(); // path (string) -> Uint8Array

  const encode = (s) => new TextEncoder().encode(s);
  const decode = (b) => new TextDecoder().decode(b);

  // ── File handle ──────────────────────────────────────────────────────────
  function makeFileHandle(name, fullPath) {
    return {
      kind: 'file',
      name,
      async getFile() {
        const bytes = store.get(fullPath) || new Uint8Array();
        // File constructor expects a sequence of BlobParts; pass the bytes
        // directly so .text() / .arrayBuffer() / .stream() all work.
        return new File([bytes], name);
      },
      async createWritable() {
        // Spec: createWritable() returns a FileSystemWritableFileStream that
        // buffers writes and only commits on close(). We accumulate into
        // a single Uint8Array (GitQi only writes whole files in one shot).
        let buf = new Uint8Array();
        const writable = {
          async write(chunk) {
            // Spec accepts: BufferSource | Blob | string | WriteParams.
            if (chunk == null) return;
            if (typeof chunk === 'string') {
              buf = encode(chunk);
              return;
            }
            if (chunk instanceof ArrayBuffer) {
              buf = new Uint8Array(chunk.slice(0));
              return;
            }
            if (ArrayBuffer.isView(chunk)) {
              buf = new Uint8Array(
                chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
              );
              return;
            }
            if (chunk instanceof Blob) {
              buf = new Uint8Array(await chunk.arrayBuffer());
              return;
            }
            if (typeof chunk === 'object' && 'type' in chunk) {
              // WriteParams: { type: 'write'|'seek'|'truncate', data?, position?, size? }
              if (chunk.type === 'write' && 'data' in chunk) {
                return writable.write(chunk.data);
              }
              if (chunk.type === 'truncate') {
                const size = chunk.size || 0;
                const out = new Uint8Array(size);
                out.set(buf.subarray(0, Math.min(size, buf.length)));
                buf = out;
                return;
              }
              // 'seek' is a no-op for our single-shot writers.
              return;
            }
          },
          async close() {
            store.set(fullPath, buf);
          },
          async abort() {
            // discard buffered writes
          },
          // Streams API methods GitQi doesn't use but might add later:
          async truncate(size) {
            const out = new Uint8Array(size || 0);
            out.set(buf.subarray(0, Math.min(out.length, buf.length)));
            buf = out;
          },
          async seek(_pos) {},
        };
        return writable;
      },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      // isSameEntry is part of the spec; GitQi doesn't use it but provide
      // a permissive implementation so debugging tools don't crash.
      async isSameEntry(other) { return other && other.name === name && other.kind === 'file'; },
    };
  }

  // ── Directory handle ─────────────────────────────────────────────────────
  function makeDirHandle(name, prefix) {
    const resolve = (n) => (prefix ? prefix + '/' + n : n);

    async function* entries() {
      const pfx = prefix ? prefix + '/' : '';
      const seenDirs = new Set();
      // Snapshot keys to avoid mutation-during-iteration surprises.
      const keys = [...store.keys()].sort();
      for (const path of keys) {
        if (!path.startsWith(pfx)) continue;
        const rest = path.slice(pfx.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          yield [rest, makeFileHandle(rest, path)];
        } else {
          const dirName = rest.slice(0, slash);
          if (seenDirs.has(dirName)) continue;
          seenDirs.add(dirName);
          yield [dirName, makeDirHandle(dirName, resolve(dirName))];
        }
      }
    }

    const handle = {
      kind: 'directory',
      name,

      async getFileHandle(n, opts = {}) {
        const path = resolve(n);
        if (!store.has(path) && !opts.create) {
          throw new DOMException(`File not found: ${path}`, 'NotFoundError');
        }
        if (!store.has(path)) store.set(path, new Uint8Array());
        return makeFileHandle(n, path);
      },

      async getDirectoryHandle(n, opts = {}) {
        const path = resolve(n);
        // Directories are implicit in our flat map. A directory "exists"
        // if any file path is prefixed by it. With { create: true } we
        // unconditionally hand back a handle — files written through it
        // will materialize the prefix.
        const hasChildren = [...store.keys()].some((k) => k.startsWith(path + '/'));
        if (!hasChildren && !opts.create) {
          throw new DOMException(`Directory not found: ${path}`, 'NotFoundError');
        }
        return makeDirHandle(n, path);
      },

      async removeEntry(n, opts = {}) {
        const path = resolve(n);
        if (store.has(path)) {
          store.delete(path);
          return;
        }
        const dirPrefix = path + '/';
        const children = [...store.keys()].filter((k) => k.startsWith(dirPrefix));
        if (children.length === 0) {
          throw new DOMException(`Entry not found: ${path}`, 'NotFoundError');
        }
        if (!opts.recursive) {
          throw new DOMException(`Directory not empty: ${path}`, 'InvalidModificationError');
        }
        for (const k of children) store.delete(k);
      },

      async resolve(_possibleDescendant) {
        // Spec returns the path segments from this handle to a descendant.
        // GitQi doesn't call this; stub returns null (= not a descendant).
        return null;
      },

      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) {
        return other && other.kind === 'directory' && other.name === name;
      },

      // Async iteration: spec exposes entries() / keys() / values() AND
      // [Symbol.asyncIterator] (which aliases entries()).
      entries,
      async *keys() { for await (const [k] of entries()) yield k; },
      async *values() { for await (const [, v] of entries()) yield v; },
      [Symbol.asyncIterator]() { return entries(); },
    };

    return handle;
  }

  // Root handle is created lazily so window.__seedFakeDisk() can populate
  // the store BEFORE GitQi reads it. The same root is returned every time
  // — multiple showDirectoryPicker() calls give back the same logical dir.
  let rootHandle = null;
  function getRoot() {
    if (!rootHandle) rootHandle = makeDirHandle('test-site', '');
    return rootHandle;
  }

  // ── Override showDirectoryPicker ─────────────────────────────────────────
  window.showDirectoryPicker = async () => getRoot();

  // ── Fake IDB for the GitQi handle DB only ────────────────────────────────
  //
  // GitQi calls indexedDB.open('__gitqi_fs', 1), creates an objectStore
  // 'handles', then puts/gets a single value at key HANDLE_KEY. Structured
  // clone would strip the methods off our fake handle, so we intercept
  // this specific DB and shadow it with a plain Map. Any other IDB usage
  // (none in current gitqi.js, but future-proof) falls through to the real
  // indexedDB.open.
  const IDB_NAME = '__gitqi_fs';
  const realOpen = indexedDB.open.bind(indexedDB);
  const fakeIdbStore = new Map(); // key -> value

  function fireMicrotask(req, eventTarget) {
    queueMicrotask(() => {
      if (req.onsuccess) req.onsuccess({ target: eventTarget || req });
    });
  }

  function fakeDb() {
    return {
      transaction(_storeName, _mode) {
        const tx = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore() {
            return {
              put(value, key) {
                fakeIdbStore.set(key, value);
                const req = { onsuccess: null, onerror: null, result: undefined };
                queueMicrotask(() => {
                  if (req.onsuccess) req.onsuccess({ target: req });
                  if (tx.oncomplete) tx.oncomplete({ target: tx });
                });
                return req;
              },
              get(key) {
                const result = fakeIdbStore.has(key) ? fakeIdbStore.get(key) : undefined;
                const req = { onsuccess: null, onerror: null, result };
                queueMicrotask(() => {
                  if (req.onsuccess) req.onsuccess({ target: req });
                });
                return req;
              },
              delete(key) {
                fakeIdbStore.delete(key);
                const req = { onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  if (req.onsuccess) req.onsuccess({ target: req });
                  if (tx.oncomplete) tx.oncomplete({ target: tx });
                });
                return req;
              },
            };
          },
        };
        return tx;
      },
      close() {},
    };
  }

  indexedDB.open = function (name, version) {
    if (name !== IDB_NAME) {
      return realOpen(name, version);
    }
    const db = fakeDb();
    const req = {
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      result: db,
    };
    queueMicrotask(() => {
      // Always fire onupgradeneeded — the real createObjectStore is a no-op
      // for us, but GitQi's handler expects to be called on first open.
      if (req.onupgradeneeded) {
        req.onupgradeneeded({
          target: { result: { createObjectStore: () => ({}) } },
        });
      }
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  };

  // ── Test-facing API ──────────────────────────────────────────────────────
  window.__seedFakeDisk = function (files) {
    for (const [path, content] of Object.entries(files || {})) {
      if (typeof content === 'string') {
        store.set(path, encode(content));
      } else if (content instanceof Uint8Array) {
        store.set(path, content);
      } else if (Array.isArray(content)) {
        store.set(path, new Uint8Array(content));
      } else {
        throw new TypeError(`__seedFakeDisk: unsupported content for ${path}`);
      }
    }
  };

  window.__fakeDisk = {
    read(path) {
      const bytes = store.get(path);
      return bytes ? decode(bytes) : null;
    },
    readBytes(path) {
      const bytes = store.get(path);
      return bytes ? Array.from(bytes) : null;
    },
    list() {
      return [...store.keys()].sort();
    },
    has(path) { return store.has(path); },
    write(path, content) {
      if (typeof content === 'string') store.set(path, encode(content));
      else store.set(path, new Uint8Array(content));
    },
    delete(path) { store.delete(path); },
    clear() {
      store.clear();
      fakeIdbStore.clear();
      rootHandle = null;
    },
  };
})();
