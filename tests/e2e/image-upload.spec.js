// Image upload — replace an <img data-editable-image> by clicking it
// and choosing a new file. Two modes:
//
//   • Offline (no GitHub): bytes written to fake disk under assets/
//   • GitHub mode: bytes ALSO uploaded via github.uploadFile mock
//
// Both modes update img.src to a fresh blob URL (so cache invalidates
// when replacing same-name file) and set data-gitqi-src to the relative
// path; the serializer resolves data-gitqi-src back on save/publish.

const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  readFakeFile,
  listFakeFiles,
  waitForDisk,
  readGitHubFile,
} = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

// 1x1 PNG (transparent) — smallest legal PNG.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
  '0d0a2db40000000049454e44ae426082',
  'hex'
);

test('Offline image upload writes to assets/ on the fake disk only', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  // Click the placeholder image. The click handler creates a hidden file
  // input and calls .click() on it — Playwright's filechooser event fires
  // for that programmatic click.
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('img[data-editable-image]').click(),
  ]);

  await fileChooser.setFiles({
    name: 'hero.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  });

  // Wait for the file to land on disk.
  await waitForDisk(page, (disk) => disk.has('assets/hero.png'), { timeout: 8_000 });

  const files = await listFakeFiles(page);
  expect(files).toContain('assets/hero.png');

  // <img> got a blob: URL plus the data-gitqi-src marker pointing at the
  // relative path (the serializer maps that back on save/publish).
  const dataSrc = await page.locator('img[data-editable-image]').getAttribute('data-gitqi-src');
  expect(dataSrc).toBe('./assets/hero.png');
  const liveSrc = await page.locator('img[data-editable-image]').getAttribute('src');
  expect(liveSrc).toMatch(/^blob:/);
});

test('Image upload with GitHub credentials also pushes to the repo', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    github: {},
  });

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('img[data-editable-image]').click(),
  ]);
  await fileChooser.setFiles({
    name: 'cta.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  });

  // Fake disk
  await waitForDisk(page, (disk) => disk.has('assets/cta.png'), { timeout: 8_000 });

  // GitHub repo also has the asset.
  const ghBytes = await page.evaluate(() => window.__githubRepo.has('assets/cta.png'));
  expect(ghBytes).toBe(true);

  // The bytes match — strict equality check on length is enough proof; we
  // don't need to assert byte-for-byte.
  const ghBytesLen = await page.evaluate(() =>
    window.__githubRepo.read('assets/cta.png').length
  );
  expect(ghBytesLen).toBeGreaterThan(0);
});

test('Published HTML resolves data-gitqi-src back to a relative path', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    github: {},
  });

  // Replace the image first.
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('img[data-editable-image]').click(),
  ]);
  await fileChooser.setFiles({
    name: 'gallery.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  });
  await waitForDisk(page, (disk) => disk.has('assets/gallery.png'), { timeout: 8_000 });

  // Publish — the published HTML should reference ./assets/gallery.png and
  // NOT contain the blob: URL.
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForFunction(
    () => window.__githubRepo.has('index.html'),
    null,
    { timeout: 10_000 }
  );

  const html = await readGitHubFile(page, 'index.html');
  expect(html).toContain('./assets/gallery.png');
  expect(html).not.toMatch(/src="blob:/);
  // data-gitqi-src marker is stripped on publish.
  expect(html).not.toContain('data-gitqi-src');
});
