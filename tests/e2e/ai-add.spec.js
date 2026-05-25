// AI Add flows — Add Section (+ between zones) and Add Page (Pages panel).
// Both route through the Gemini mock; the test asserts the AI is called
// with the user's description and the resulting content lands in the DOM
// / on disk.

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

test('Add Section inserts AI-generated section with its own style block', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: { geminiKey: 'fake-key' },
    gemini: {
      type: 'section',
      css: '[data-zone="testimonials"] { background: var(--color-bg-alt); }',
      html: `<section data-zone="testimonials" data-zone-label="Testimonials">
        <h2 data-editable>What people say</h2>
        <p data-editable>A glowing review.</p>
      </section>`,
    },
  });

  // The (+) buttons live between zones. Hover the first one and click.
  // Wrap is .__gitqi-add-wrap (data-editor-ui), button inside.
  const firstAddBtn = page.locator('.__gitqi-add-wrap button').first();
  await firstAddBtn.click({ force: true });

  await page.locator('#__gitqi-ai-desc').fill('A testimonials section with 1 quote');
  await page.locator('#__gitqi-ai-submit').click();

  await expect(page.locator('section[data-zone="testimonials"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('section[data-zone="testimonials"] h2')).toHaveText('What people say');

  // Per-section style block was created.
  await expect(page.locator('style#__gitqi-section-testimonials-styles')).toHaveCount(1);

  // Gemini got the description.
  const calls = await getGeminiCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain('A testimonials section with 1 quote');
});

test('Add Page writes a new file, registers it, and adds a nav link', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: { geminiKey: 'fake-key' },
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
    gemini: {
      type: 'page',
      html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Services — GitQi Test Site</title>
  <style>:root { --color-primary: #1a1b3a; --color-bg: #fff; --color-text: #333; --font-body: sans-serif; --font-heading: sans-serif; } body { margin: 0; font-family: var(--font-body); }</style>
</head>
<body>
  <nav><ul><li><a href="index.html">Home</a></li><li><a href="about.html">About</a></li><li><a href="services.html" class="active">Services</a></li></ul></nav>
  <main>
    <section data-zone="hero" data-zone-label="Hero">
      <h1 data-editable>Our Services</h1>
      <p data-editable>What we offer.</p>
    </section>
  </main>
  <footer data-zone="footer" data-zone-label="Footer">
    <p data-editable>&copy; Test Site.</p>
  </footer>
</body>
</html>`,
    },
  });

  // Open Pages panel → "+ Add Page" lives at the bottom.
  await page.getByRole('button', { name: 'Pages' }).click();
  await page.getByRole('button', { name: /Add Page/ }).click();

  await page.locator('#__gitqi-addpage-desc').fill('A services page listing three services');
  await page.locator('#__gitqi-addpage-label').fill('Services');
  await page.locator('#__gitqi-addpage-submit').click();

  // New file on disk.
  await waitForDisk(page, (disk) => disk.has('services.html'), { timeout: 10_000 });
  const newPage = await readFakeFile(page, 'services.html');
  expect(newPage).toContain('Our Services');

  // Inventory updated.
  const inv = JSON.parse(await readFakeFile(page, 'gitqi-pages.json'));
  expect(inv.pages.map((p) => p.file)).toContain('services.html');

  // Live nav got the link (addLinkToNav is called programmatically AFTER
  // the AI returns, so it's authoritative regardless of what the AI
  // happened to put in the nav of its response).
  await expect(page.locator('nav a[href="./services.html"]')).toHaveText('Services');

  // Sync ran — about.html now has services in its nav.
  await waitForDisk(
    page,
    (disk) => (disk.read('about.html') || '').includes('services.html'),
    { timeout: 10_000 }
  );

  const calls = await getGeminiCalls(page);
  expect(calls[0].prompt).toContain('A services page listing three services');
});
