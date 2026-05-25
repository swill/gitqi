// Page Init — scanner that adds data-zone / data-editable / data-editable-image
// markers to a plain HTML page so GitQi can manage it. Two surfaces:
//
//   • Live DOM    — via ⚙ Site Utilities → "✨ Init this page"
//   • Disk doc    — via Pages panel → per-row ✨ on non-current rows
//
// Idempotent — running twice on the same DOM is a no-op.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  readFakeFile,
  waitForDisk,
} = require('../helpers/setup');

const BARE_FIXTURE = '/tests/fixtures/bare/index.html';
const BARE_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'bare', 'index.html'),
  'utf8'
);

test('Live init tags sections, headings, and paragraphs in the current page', async ({ page }) => {
  await setupEditor(page, BARE_FIXTURE);

  // Before init: no markers anywhere.
  await expect(page.locator('[data-zone]')).toHaveCount(0);
  await expect(page.locator('[data-editable]')).toHaveCount(0);

  // Open ⚙ → ✨ Init this page.
  await page.getByRole('button', { name: '⚙' }).click();
  await page.getByRole('button', { name: /Init this page/ }).click();

  // After init: every <section> got data-zone, headings + paragraphs got
  // data-editable, the <footer> got data-zone too. Two sections + footer
  // in the fixture → at least 3 zones.
  await expect(page.locator('[data-zone]')).toHaveCount(3);
  await expect(page.locator('h1[data-editable]')).toHaveText('Bare Heading');
  await expect(page.locator('p[data-editable]').first()).toBeVisible();

  // List items also tagged (per INIT logic: h1-h6 / p / li / a).
  await expect(page.locator('li[data-editable]')).toHaveCount(2);

  // Page is now dirty — wait for autosave to land the tagging on disk.
  await waitForDisk(
    page,
    (disk) => (disk.read('index.html') || '').includes('data-zone'),
    { timeout: 8_000 }
  );
});

test('Live init is idempotent — re-running shows "Nothing new to init"', async ({ page }) => {
  await setupEditor(page, BARE_FIXTURE);

  // First run.
  await page.getByRole('button', { name: '⚙' }).click();
  await page.getByRole('button', { name: /Init this page/ }).click();
  await expect(page.locator('[data-zone]').first()).toBeVisible();

  const zonesAfterFirst = await page.locator('[data-zone]').count();

  // Second run.
  await page.getByRole('button', { name: '⚙' }).click();
  await page.getByRole('button', { name: /Init this page/ }).click();

  // No new markers (zone count unchanged).
  await expect(page.locator('[data-zone]')).toHaveCount(zonesAfterFirst);

  // Status message confirms it.
  await expect(page.locator('#__gitqi-toolbar')).toContainText(/already managed/i);
});

test('Disk init via Pages panel rewrites a non-current page on disk', async ({ page }) => {
  // Current page (index.html) is a fully-tagged GitQi site. The disk has
  // a separate bare-other.html that we will init from the Pages panel.
  const BARE_DISK_PAGE = '/tests/fixtures/site/index.html';

  // Use the normal site fixture as the loaded page, but pre-seed a bare
  // "other" page on disk + register it in the inventory.
  const otherBare = BARE_HTML.replace('<title>Bare Test Site</title>', '<title>Other Bare Page</title>');
  await setupEditor(page, BARE_DISK_PAGE, {
    diskFiles: {
      'other.html': otherBare,
      'gitqi-pages.json': JSON.stringify({
        pages: [
          { file: 'index.html', title: 'GitQi Test Site', navLabel: 'Home' },
          { file: 'other.html', title: 'Other Bare Page', navLabel: 'Other' },
        ],
      }, null, 2),
    },
  });

  // Open Pages panel, click ✨ on the other.html row.
  await page.getByRole('button', { name: 'Pages' }).click();
  const otherRow = page.locator('#__gitqi-pages-panel')
    .getByText('other.html', { exact: false })
    .locator('xpath=../..');
  await otherRow.getByRole('button', { name: '✨' }).click();

  // Wait for the disk write — the bare page now contains data-zone.
  await waitForDisk(
    page,
    (disk) => (disk.read('other.html') || '').includes('data-zone'),
    { timeout: 8_000 }
  );

  const rewritten = await readFakeFile(page, 'other.html');
  expect(rewritten).toContain('data-zone');
  expect(rewritten).toContain('data-editable');
});
