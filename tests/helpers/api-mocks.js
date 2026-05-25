// api-mocks.js — runs in the BROWSER as a Playwright init script.
//
// Intercepts window.fetch for the two external APIs GitQi uses:
//
//   • generativelanguage.googleapis.com  — Gemini (AI flows)
//   • api.github.com                     — GitHub (Publish, asset cleanup)
//
// Any other URL falls through to real fetch (e.g. /gitqi.js, /google-fonts.json
// served by the test webServer). This is install-once, configure-per-test:
// the init script wires up the interceptor with no-op defaults; tests then
// call window.__configureGemini / window.__configureGitHub to install
// behavior. The test-side wrappers in setup.js call these via page.evaluate.
//
// State exposed for assertions:
//   window.__fetchLog        — every intercepted call, in order
//   window.__githubRepo.list / read / has / put / delete
//   window.__geminiCalls     — convenience subset of __fetchLog
//
// Both interceptors are deliberately permissive — unknown paths return a
// "no mock" 500 with a descriptive body so test failures point at the
// missing configuration rather than at a cryptic GitQi error.

(function () {
  if (window.__apiMocksInstalled) return; // idempotent
  window.__apiMocksInstalled = true;

  const realFetch = window.fetch.bind(window);

  // ── Call log ─────────────────────────────────────────────────────────────
  // Every intercepted call lands here. Tests can inspect to assert on
  // request shape (e.g. "publish wrote index.html with the new headline").
  window.__fetchLog = [];

  function record(entry) {
    window.__fetchLog.push(entry);
    return entry;
  }

  // ── Gemini responder ─────────────────────────────────────────────────────
  // Default responder fails loudly so tests that forget to configure one
  // see a clear error instead of a mysterious "AI returned empty response".
  let geminiResponder = () => ({
    status: 500,
    body: { error: { message: 'No Gemini mock configured. Call __configureGemini in your test.' } },
  });
  let geminiCallIndex = 0;

  /**
   * Install a Gemini responder. Two shapes accepted:
   *
   *   1. Static object — same response every call:
   *        { type: 'section', css: '...', html: '...' }
   *        { type: 'nav',     html: '...', css?: '...' }
   *        { type: 'page',    html: '<!DOCTYPE html><html>...</html>' }
   *        { text: 'raw response text' }
   *        { status: 503, errorMessage: 'Model overloaded' }
   *
   *   2. Function — called per request with { prompt, model, callIndex },
   *      should return one of the above shapes. Useful for testing the
   *      model-fallback chain (fail on first model, succeed on second).
   */
  window.__configureGemini = function (responderOrSpec) {
    geminiCallIndex = 0;
    if (typeof responderOrSpec === 'function') {
      geminiResponder = responderOrSpec;
    } else {
      geminiResponder = () => responderOrSpec;
    }
  };

  function buildGeminiText(spec) {
    if (spec.text != null) return spec.text;
    switch (spec.type) {
      case 'section':
        return (
          `<section-css>${spec.css || ''}</section-css>` +
          `<section-html>${spec.html || ''}</section-html>`
        );
      case 'nav':
        return (
          `<nav-html>${spec.html || ''}</nav-html>` +
          (spec.css ? `<nav-css>${spec.css}</nav-css>` : '')
        );
      case 'page':
        return spec.html || '';
      default:
        throw new Error(`api-mocks: unknown Gemini spec type "${spec.type}"`);
    }
  }

  async function handleGemini(url, options) {
    const body = options.body ? JSON.parse(options.body) : {};
    const prompt = body?.contents?.[0]?.parts?.[0]?.text || '';
    const model = (url.match(/\/models\/([^:]+):/) || [])[1] || 'unknown';
    const callIndex = geminiCallIndex++;

    const entry = record({
      kind: 'gemini',
      url,
      method: 'POST',
      model,
      prompt,
      callIndex,
    });

    let spec;
    try {
      spec = await geminiResponder({ prompt, model, callIndex });
    } catch (err) {
      entry.responderThrew = err.message;
      return new Response(
        JSON.stringify({ error: { message: 'Gemini responder threw: ' + err.message } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Error path — status >= 400. GitQi's fallback layer expects an error
    // body with { error: { message: ... } } so it can surface a useful msg.
    if (spec && spec.status && spec.status >= 400) {
      entry.responseStatus = spec.status;
      return new Response(
        JSON.stringify({
          error: { message: spec.errorMessage || `Mocked failure (status ${spec.status})` },
        }),
        { status: spec.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Success path — wrap the text in the candidates envelope GitQi parses.
    const text = buildGeminiText(spec);
    entry.responseStatus = 200;
    entry.responseText = text;
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── GitHub repo simulator ────────────────────────────────────────────────
  //
  // GitQi uses /repos/{owner}/{repo}/contents/{path} for everything: read
  // SHA (GET), write file (PUT), delete (DELETE), list dir (GET on a dir).
  // We maintain a Map<path, { bytes, sha }> and serve canonical responses.
  //
  // SHA strategy: 7-char hex of an increment counter, prefixed with the
  // path's length for variety. Tests rarely care about the exact value;
  // what matters is that getFileSHA → putFile(sha) returns the same sha
  // for an unchanged file.

  const repo = new Map(); // path -> { bytes: Uint8Array, sha: string }
  let shaCounter = 0;
  function nextSha(path) {
    shaCounter += 1;
    return (path.length.toString(16) + shaCounter.toString(16)).padStart(7, '0').slice(0, 7) +
      Math.random().toString(16).slice(2, 35);
  }

  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);

  function putRaw(path, content) {
    const bytes = typeof content === 'string' ? enc(content) :
                  content instanceof Uint8Array ? content :
                  Array.isArray(content) ? new Uint8Array(content) :
                  enc(String(content));
    const sha = nextSha(path);
    repo.set(path, { bytes, sha });
    return sha;
  }

  window.__githubRepo = {
    list() { return [...repo.keys()].sort(); },
    read(path) {
      const f = repo.get(path);
      return f ? dec(f.bytes) : null;
    },
    has(path) { return repo.has(path); },
    sha(path) { return repo.get(path)?.sha || null; },
    put(path, content) { return putRaw(path, content); },
    delete(path) { return repo.delete(path); },
    clear() { repo.clear(); shaCounter = 0; },
  };

  /**
   * Optionally pre-seed the GitHub repo before a test runs.
   *   { initialFiles: { 'index.html': '<!DOCTYPE html>...', 'assets/a.png': Uint8Array | number[] } }
   */
  window.__configureGitHub = function (opts = {}) {
    repo.clear();
    shaCounter = 0;
    const initialFiles = opts.initialFiles || {};
    for (const [path, content] of Object.entries(initialFiles)) {
      putRaw(path, content);
    }
  };

  function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // /repos/{owner}/{repo}/contents/{path}[?ref=...]
  // The "path" segment in the URL is URI-encoded by GitQi via encodeURIComponent,
  // so `/` in the path becomes `%2F`. We decode here to recover the original.
  function parseGitHubContentsURL(url) {
    const m = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\/contents\/([^?]*)/);
    if (!m) return null;
    return {
      repoFullName: m[1],
      path: decodeURIComponent(m[2]),
    };
  }

  async function handleGitHub(url, options) {
    const method = (options.method || 'GET').toUpperCase();
    const parsed = parseGitHubContentsURL(url);
    const entry = record({
      kind: 'github',
      url,
      method,
      path: parsed?.path || null,
    });

    if (!parsed) {
      entry.responseStatus = 500;
      return jsonResponse({ message: 'api-mocks: unrecognized GitHub URL ' + url }, 500);
    }

    const { path } = parsed;

    if (method === 'GET') {
      // Directory listing — empty path or matches a known dir prefix.
      const asDir = path === '' || [...repo.keys()].some((k) => k.startsWith(path + '/'));
      const asFile = repo.has(path);
      if (asFile) {
        const f = repo.get(path);
        entry.responseStatus = 200;
        // contents endpoint returns base64 of file content for files.
        return jsonResponse({
          name: path.split('/').pop(),
          path,
          sha: f.sha,
          type: 'file',
          encoding: 'base64',
          content: btoa(String.fromCharCode(...f.bytes)),
        });
      }
      if (asDir && path !== '') {
        const prefix = path + '/';
        const children = new Map(); // name -> { path, type, sha }
        for (const [p, info] of repo.entries()) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash === -1) {
            children.set(rest, { name: rest, path: p, sha: info.sha, type: 'file' });
          } else {
            const dn = rest.slice(0, slash);
            if (!children.has(dn)) {
              children.set(dn, { name: dn, path: prefix + dn, sha: '', type: 'dir' });
            }
          }
        }
        entry.responseStatus = 200;
        return jsonResponse([...children.values()]);
      }
      entry.responseStatus = 404;
      return jsonResponse({ message: 'Not Found' }, 404);
    }

    if (method === 'PUT') {
      const body = options.body ? JSON.parse(options.body) : {};
      const existing = repo.get(path);
      // Real GitHub: PUT to an existing file without a sha → 409.
      if (existing && !body.sha) {
        entry.responseStatus = 409;
        return jsonResponse({ message: 'sha required to update existing file' }, 409);
      }
      // Real GitHub: PUT with a stale sha → 409. (Tests can simulate this by
      // mutating __githubRepo between getFileSHA and putFile.)
      if (existing && body.sha && body.sha !== existing.sha) {
        entry.responseStatus = 409;
        return jsonResponse({ message: 'sha mismatch' }, 409);
      }
      // Decode the base64 content into bytes for the repo.
      let bytes = new Uint8Array();
      if (typeof body.content === 'string') {
        const binary = atob(body.content);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      }
      const newSha = nextSha(path);
      repo.set(path, { bytes, sha: newSha });
      entry.responseStatus = 200;
      return jsonResponse({ content: { path, sha: newSha } });
    }

    if (method === 'DELETE') {
      const existing = repo.get(path);
      if (!existing) {
        entry.responseStatus = 404;
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      const body = options.body ? JSON.parse(options.body) : {};
      if (body.sha && body.sha !== existing.sha) {
        entry.responseStatus = 409;
        return jsonResponse({ message: 'sha mismatch' }, 409);
      }
      repo.delete(path);
      entry.responseStatus = 200;
      return jsonResponse({ commit: { sha: nextSha(path) } });
    }

    entry.responseStatus = 405;
    return jsonResponse({ message: 'Method not allowed: ' + method }, 405);
  }

  // ── Top-level fetch interceptor ──────────────────────────────────────────
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const opts = typeof input === 'object' && input !== null && input !== Object(init)
      ? { ...input, ...init } : init;

    if (url.includes('generativelanguage.googleapis.com')) {
      return handleGemini(url, opts);
    }
    if (url.includes('api.github.com')) {
      return handleGitHub(url, opts);
    }
    return realFetch(input, init);
  };

  // Convenience view: just the Gemini calls.
  Object.defineProperty(window, '__geminiCalls', {
    get() { return window.__fetchLog.filter((e) => e.kind === 'gemini'); },
  });

  Object.defineProperty(window, '__githubCalls', {
    get() { return window.__fetchLog.filter((e) => e.kind === 'github'); },
  });
})();
