// Theme editor — change a CSS variable via the hex input, assert live
// preview + persistence + propagation to other pages.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  readFakeFile,
  waitForDisk,
} = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';
const ABOUT_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'site', 'about.html'),
  'utf8'
);
const INVENTORY = JSON.stringify({
  pages: [
    { file: 'index.html', title: 'GitQi Test Site', navLabel: 'Home' },
    { file: 'about.html', title: 'About — GitQi Test Site', navLabel: 'About' },
  ],
}, null, 2);

test('Changing --color-primary in the Theme panel previews live, saves to disk, and syncs to other pages', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  // Open the Theme panel.
  await page.getByRole('button', { name: 'Theme' }).click();
  await expect(page.locator('#__gitqi-theme-panel')).toBeVisible();

  // Find the row for --color-primary by its label[title="--color-primary"]
  // and the adjacent hex input.
  const colorPrimaryRow = page.locator(
    '#__gitqi-theme-panel label[title="--color-primary"]'
  ).locator('xpath=..');
  const hexInput = colorPrimaryRow.locator('input[type="text"]');

  // Sanity: starts at the fixture's value.
  await expect(hexInput).toHaveValue(/#1a1b3a/i);

  // Change to red.
  await hexInput.fill('#ff0000');

  // Live preview: documentElement should reflect the new value via
  // the patched main <style>. computedStyle reads from the cascade.
  await expect.poll(
    async () =>
      await page.evaluate(() => {
        const styles = [...document.querySelectorAll('head > style')];
        const main = styles.find((s) => /:root\s*\{/.test(s.textContent || ''));
        return /--color-primary:\s*#ff0000/.test(main?.textContent || '');
      }),
    { timeout: 4_000 }
  ).toBe(true);

  // Persistence: auto-save writes the new value into index.html on disk.
  await waitForDisk(
    page,
    (disk) => (disk.read('index.html') || '').includes('#ff0000'),
    { timeout: 8_000 }
  );

  // Propagation: shared-head sync pushed the updated <style> to about.html.
  await waitForDisk(
    page,
    (disk) => (disk.read('about.html') || '').includes('#ff0000'),
    { timeout: 8_000 }
  );

  const indexAfter = await readFakeFile(page, 'index.html');
  const aboutAfter = await readFakeFile(page, 'about.html');
  expect(indexAfter).toMatch(/--color-primary:\s*#ff0000/);
  expect(aboutAfter).toMatch(/--color-primary:\s*#ff0000/);
});
