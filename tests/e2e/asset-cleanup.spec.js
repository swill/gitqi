// Asset cleanup — find orphans under assets/ (referenced by nothing) and
// delete them from both fake disk and GitHub. We seed two assets: one
// referenced from the live page's <img>, one orphan. Only the orphan
// should be deletable.

const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  listFakeFiles,
  waitForDisk,
} = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

// 1x1 PNG.
const PNG_BYTES = [
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,
  0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,
  0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82,
];

test('Asset cleanup deletes orphans from both fake disk and GitHub repo', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    diskFiles: {
      // Pre-seed two assets on disk: one referenced by the fixture's
      // <img src> (we update the img to reference it below), one orphan.
      'assets/used.png':   PNG_BYTES,
      'assets/orphan.png': PNG_BYTES,
    },
    github: {
      initialFiles: {
        'assets/used.png':   PNG_BYTES,
        'assets/orphan.png': PNG_BYTES,
      },
    },
  });

  // Point the fixture's <img> at used.png so the scanner sees it as
  // referenced. (The fixture's default img src is a data URI which the
  // scanner correctly classifies as "not an assets/ ref".)
  await page.evaluate(() => {
    const img = document.querySelector('img[data-editable-image]');
    img.src = './assets/used.png';
  });

  // Open ⚙ Site Utilities → 🧹 Clean up unused assets.
  await page.getByRole('button', { name: '⚙' }).click();
  await page.getByRole('button', { name: /Clean up unused assets/ }).click();

  // Scanner runs; once the list renders, the summary names the orphan count.
  await expect(page.locator('#__gitqi-cleanup-summary')).toContainText('1 unused', {
    timeout: 8_000,
  });
  // The orphan path is listed (with the assets/ prefix).
  await expect(page.locator('#__gitqi-cleanup-list')).toContainText('assets/orphan.png');
  // The used asset is NOT listed.
  await expect(page.locator('#__gitqi-cleanup-list')).not.toContainText('assets/used.png');

  await page.locator('#__gitqi-cleanup-confirm').click();

  // Orphan gone from fake disk.
  await waitForDisk(page, (disk) => !disk.has('assets/orphan.png'), { timeout: 8_000 });
  expect(await listFakeFiles(page)).toContain('assets/used.png');

  // Orphan gone from GitHub mock too. used.png remains.
  const ghHas = await page.evaluate(() => ({
    used:   window.__githubRepo.has('assets/used.png'),
    orphan: window.__githubRepo.has('assets/orphan.png'),
  }));
  expect(ghHas).toEqual({ used: true, orphan: false });
});

test('Asset cleanup shows "Nothing to clean up" when no orphans exist', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'assets/used.png': PNG_BYTES,
    },
  });
  await page.evaluate(() => {
    const img = document.querySelector('img[data-editable-image]');
    img.src = './assets/used.png';
  });

  await page.getByRole('button', { name: '⚙' }).click();
  await page.getByRole('button', { name: /Clean up unused assets/ }).click();

  await expect(page.locator('#__gitqi-cleanup-list')).toContainText(
    'Everything is in use',
    { timeout: 8_000 }
  );
});
