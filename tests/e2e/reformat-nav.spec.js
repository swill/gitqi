// Reformat Nav — AI flow that replaces <nav> verbatim from the model's
// response, then force-syncs the new nav across all other pages.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  readFakeFile,
  waitForDisk,
  getGeminiCalls,
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

const NEW_NAV_HTML = `<nav>
  <div class="brand">Brand</div>
  <ul>
    <li><a href="index.html" class="active">Home</a></li>
    <li><a href="about.html">About</a></li>
  </ul>
</nav>`;

test('Reformat Nav swaps the nav and force-syncs the change to other pages', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: { geminiKey: 'fake-key' },
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
    gemini: {
      type: 'nav',
      html: NEW_NAV_HTML,
      css: 'nav { display: flex; justify-content: space-between; }',
    },
  });

  // Hover the nav to reveal the "⟳ Reformat Nav" button.
  const nav = page.locator('nav').first();
  await nav.hover();
  await page.getByRole('button', { name: /Reformat Nav/ }).click({ force: true });

  await page.locator('#__gitqi-reformat-nav-desc').fill('Add a brand on the left');
  await page.locator('#__gitqi-reformat-nav-submit').click();

  // Live nav was replaced — assert via the new "brand" element which was
  // not present in the original.
  await expect(page.locator('nav .brand')).toBeVisible({ timeout: 10_000 });

  // Force-sync wrote the new nav into about.html. The destination's
  // active marker was retargeted to the about link (per
  // retargetActiveMarker behavior).
  await waitForDisk(
    page,
    (disk) => (disk.read('about.html') || '').includes('brand'),
    { timeout: 10_000 }
  );

  const aboutAfter = await readFakeFile(page, 'about.html');
  expect(aboutAfter).toContain('class="brand"');
  expect(aboutAfter).toMatch(/<a[^>]*href="about\.html"[^>]*class="[^"]*active/);

  // Nav-specific style block also got the new CSS.
  const navStyle = await page.locator('style#__gitqi-nav-styles').textContent();
  expect(navStyle).toContain('justify-content: space-between');

  // Gemini was called once with the description.
  const calls = await getGeminiCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain('Add a brand on the left');
});
