// Publish-time output transformations:
//   1. Mailto links are obfuscated (href→javascript:void(0), data-gqe payload,
//      address-as-text replaced with data-gqt spans, decoder script appended).
//   2. data-gitqi-style marker is stripped from styled spans (the inline style
//      itself is preserved, only the marker attribute is removed).
//
// Both transforms apply ONLY in serialize({local: false}) — local saves keep
// the plain mailto + marker so re-opens behave correctly.

const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  readFakeFile,
  readGitHubFile,
} = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/links/index.html';

test('Publish obfuscates mailto links and appends a decoder script', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    github: {},
  });

  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForFunction(
    () => window.__githubRepo.has('index.html'),
    null,
    { timeout: 10_000 }
  );

  const published = await readGitHubFile(page, 'index.html');

  // mailto link: href is the inert sentinel, data-gqe carries the encoded URL.
  expect(published).toMatch(/<a[^>]*href="javascript:void\(0\)"[^>]*data-gqe="/);
  expect(published).not.toContain('mailto:hello@example.com');

  // The plain email text in the anchor body has been replaced with a
  // data-gqt span — the address never appears in plain text in the
  // published bytes.
  expect(published).not.toMatch(/>hello@example\.com</);
  expect(published).toContain('data-gqt=');

  // Decoder script is appended once.
  const decoderMatches = published.match(/data-gqe-decoder/g) || [];
  expect(decoderMatches).toHaveLength(1);
});

test('Local autosave keeps plain mailto (no obfuscation)', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  // Trigger an autosave by editing a heading.
  const heading = page.locator('section[data-zone="hero"] h1[data-editable]');
  await heading.click({ clickCount: 3 });
  await page.keyboard.type('Trigger save');

  await page.waitForFunction(
    () => (window.__fakeDisk.read('index.html') || '').includes('Trigger save'),
    null,
    { timeout: 8_000 }
  );

  const saved = await readFakeFile(page, 'index.html');
  // Local save retains the plain mailto + plain text.
  expect(saved).toContain('mailto:hello@example.com');
  expect(saved).toContain('>hello@example.com<');
  expect(saved).not.toContain('data-gqe-decoder');
});

test('Publish strips data-gitqi-style markers but preserves inline styles', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    github: {},
  });

  // Inject a styled span with the marker into an editable paragraph (a
  // proxy for what wrapSelectionInStyledSpan produces — exercising the
  // color flyout in this test would be high effort and low marginal
  // signal). The serializer's job is to strip the marker on publish.
  await page.evaluate(() => {
    const p = document.querySelector('section[data-zone="hero"] p[data-editable]');
    p.innerHTML = 'Some <span data-gitqi-style style="color: red">red</span> text';
  });

  // Trigger a save first so the live edit lands on disk in local form.
  // (Publish reads OTHER pages from disk; the current page goes through
  // serialize({local:false}) directly. Both paths strip data-gitqi-style.)
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForFunction(
    () => window.__githubRepo.has('index.html'),
    null,
    { timeout: 10_000 }
  );

  const published = await readGitHubFile(page, 'index.html');

  // Marker attribute is gone but the inline style remains.
  expect(published).not.toContain('data-gitqi-style');
  expect(published).toContain('<span style="color: red">red</span>');
});

test('Local save preserves data-gitqi-style markers (so re-opens stay clean)', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  await page.evaluate(() => {
    const p = document.querySelector('section[data-zone="hero"] p[data-editable]');
    p.innerHTML = 'Some <span data-gitqi-style style="color: red">red</span> text';
    // Manually dispatch a mutation so the observer fires and dirty is set
    // (innerHTML rewrite via evaluate is observed by the mutation observer,
    // but we need a small change to be sure auto-save runs).
    p.appendChild(document.createTextNode(' '));
  });

  await page.waitForFunction(
    () => (window.__fakeDisk.read('index.html') || '').includes('data-gitqi-style'),
    null,
    { timeout: 8_000 }
  );

  const saved = await readFakeFile(page, 'index.html');
  expect(saved).toContain('data-gitqi-style');
});
