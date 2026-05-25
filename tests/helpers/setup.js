// Test-side helpers for loading the editor into a Playwright page with
// the fakes installed. Keep this thin — anything that has to run in the
// browser belongs in fake-fs.js or api-mocks.js.

const fs = require('fs');
const path = require('path');

const FAKE_FS_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'fake-fs.js'),
  'utf8'
);
const API_MOCKS_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'api-mocks.js'),
  'utf8'
);

/**
 * Load a fixture page with the fake FSAPI + fetch interceptor installed
 * BEFORE any page script runs, then click through GitQi's folder-access
 * banner so the editor is fully active by the time the test starts
 * asserting.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fixturePath  — URL path, e.g. '/tests/fixtures/site/index.html'
 * @param {object} [opts]
 * @param {Record<string,string|Uint8Array>} [opts.diskFiles] — pre-seed the fake disk
 * @param {object} [opts.secrets] — window.SITE_SECRETS (offline mode if omitted)
 * @param {object|Function} [opts.gemini] — Gemini responder (see api-mocks.js)
 * @param {object} [opts.github] — { initialFiles: { 'path': 'content' } }
 */
async function setupEditor(page, fixturePath, opts = {}) {
  const {
    diskFiles = {},
    secrets = null,
    gemini = null,
    github = null,
  } = opts;

  // Surface page errors and console errors. Silent JS exceptions in
  // gitqi.js would otherwise produce mysterious test timeouts.
  page.on('pageerror', (err) => {
    throw new Error(`Uncaught exception in page: ${err.stack || err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // eslint-disable-next-line no-console
      console.error('[browser console.error]', msg.text());
    }
  });

  // Inject the two mock scripts before any page script runs. addInitScript
  // calls fire FIFO on every navigation, so __seedFakeDisk / __configureGemini
  // are guaranteed to exist when the third init script runs.
  await page.addInitScript({ content: FAKE_FS_SCRIPT });
  await page.addInitScript({ content: API_MOCKS_SCRIPT });

  // Seed state and optionally set SITE_SECRETS. addInitScript args
  // round-trip through structured clone, which doesn't handle functions —
  // so when `gemini` is a per-call responder function, we stringify it
  // here and rebuild in the browser. Static specs (plain objects) clone
  // fine and skip the serialization dance.
  const geminiPayload = typeof gemini === 'function'
    ? { kind: 'function', source: gemini.toString() }
    : (gemini ? { kind: 'spec', value: gemini } : null);

  await page.addInitScript(
    ({ diskFiles, secrets, geminiPayload, github }) => {
      window.__seedFakeDisk(diskFiles);
      if (secrets) window.SITE_SECRETS = secrets;
      if (geminiPayload) {
        if (geminiPayload.kind === 'function') {
          // eslint-disable-next-line no-new-func
          const fn = new Function('return (' + geminiPayload.source + ')')();
          window.__configureGemini(fn);
        } else {
          window.__configureGemini(geminiPayload.value);
        }
      }
      if (github) window.__configureGitHub(github);
    },
    { diskFiles, secrets, geminiPayload, github }
  );

  await page.goto(fixturePath);

  // Fake showDirectoryPicker resolves immediately, so clicking the
  // "Select Folder" button clears the overlay and reaches editor-live.
  await page.locator('#__gitqi-banner-grant').click();

  await page.locator('#__gitqi-toolbar').waitFor({ state: 'visible' });
  await page.locator('#__gitqi-access-banner').waitFor({ state: 'detached' });
}

// ── Fake disk helpers ──────────────────────────────────────────────────────

async function readFakeFile(page, filePath) {
  return await page.evaluate((p) => window.__fakeDisk.read(p), filePath);
}

async function listFakeFiles(page) {
  return await page.evaluate(() => window.__fakeDisk.list());
}

/**
 * Wait until a predicate against the fake disk becomes true. Use this
 * instead of fixed waitForTimeout — GitQi's auto-save debounce is 1500ms
 * and tests get flaky when the debounce changes.
 */
async function waitForDisk(page, predicateFn, opts = {}) {
  const { timeout = 8_000, interval = 100 } = opts;
  await page.waitForFunction(
    (predicateSource) => {
      const fn = new Function('disk', `return (${predicateSource})(disk);`);
      return fn(window.__fakeDisk);
    },
    predicateFn.toString(),
    { timeout, polling: interval }
  );
}

// ── API mock helpers ───────────────────────────────────────────────────────

/**
 * Configure (or reconfigure) the Gemini responder mid-test. Accepts the
 * same shapes as setupEditor's `gemini` option — static spec or a function
 * `(call) => spec`. The function form runs IN THE BROWSER (we send the
 * source over and reconstruct), so it can't close over Node values.
 */
async function configureGemini(page, responderOrSpec) {
  if (typeof responderOrSpec === 'function') {
    const source = responderOrSpec.toString();
    await page.evaluate((src) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + src + ')')();
      window.__configureGemini(fn);
    }, source);
  } else {
    await page.evaluate((spec) => window.__configureGemini(spec), responderOrSpec);
  }
}

/**
 * Pre-seed or reset the in-memory GitHub repo. Pass { initialFiles: {...} }
 * to write a starting state; pass {} (or omit) to just clear.
 */
async function configureGitHub(page, opts = {}) {
  await page.evaluate((o) => window.__configureGitHub(o), opts);
}

/** Every intercepted call, in order. */
async function getFetchLog(page) {
  return await page.evaluate(() => window.__fetchLog);
}

/** Just the Gemini calls (convenience filter on __fetchLog). */
async function getGeminiCalls(page) {
  return await page.evaluate(() => window.__geminiCalls);
}

/** Just the GitHub calls. */
async function getGitHubCalls(page) {
  return await page.evaluate(() => window.__githubCalls);
}

/**
 * Snapshot of the GitHub repo as { path: stringContent }. Use this to
 * assert what got published / written / deleted.
 */
async function getGitHubRepo(page) {
  return await page.evaluate(() => {
    const out = {};
    for (const p of window.__githubRepo.list()) {
      out[p] = window.__githubRepo.read(p);
    }
    return out;
  });
}

async function readGitHubFile(page, filePath) {
  return await page.evaluate((p) => window.__githubRepo.read(p), filePath);
}

/**
 * Wait until a predicate against the GitHub repo becomes true. Mirrors
 * waitForDisk for the same reasons.
 */
async function waitForGitHub(page, predicateFn, opts = {}) {
  const { timeout = 10_000, interval = 100 } = opts;
  await page.waitForFunction(
    (predicateSource) => {
      const fn = new Function('repo', `return (${predicateSource})(repo);`);
      return fn(window.__githubRepo);
    },
    predicateFn.toString(),
    { timeout, polling: interval }
  );
}

module.exports = {
  setupEditor,
  // Disk
  readFakeFile,
  listFakeFiles,
  waitForDisk,
  // API mocks
  configureGemini,
  configureGitHub,
  getFetchLog,
  getGeminiCalls,
  getGitHubCalls,
  getGitHubRepo,
  readGitHubFile,
  waitForGitHub,
};
