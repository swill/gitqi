// Duplicate Section + Duplicate Page — no-AI flows that copy existing
// content and rewrite slugs / filenames / titles. The slug regen and the
// per-section CSS rewrite are the parts most likely to silently regress.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  readFakeFile,
  listFakeFiles,
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

test('Duplicate Section clones with a unique slug', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await hero.getByRole('button', { name: /Duplicate/ }).click();

  // -2 suffix is what generateUniqueZoneSlug produces on the first clone.
  await expect(page.locator('section[data-zone="hero-2"]')).toBeVisible();
  await expect(page.locator('section[data-zone="hero-2"] h1')).toHaveText(
    'Welcome to the Test Site'
  );

  // Clone again — second copy should land at -3 (not collide with -2).
  await page.locator('section[data-zone="hero"]').hover();
  await page.locator('section[data-zone="hero"]').getByRole('button', { name: /Duplicate/ }).click();
  await expect(page.locator('section[data-zone="hero-3"]')).toBeVisible();
  await expect(page.locator('section[data-zone^="hero"]')).toHaveCount(3);
});

test('Duplicate Section rewrites per-section CSS slug references', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  // Seed a per-section style block so we have something to rewrite. We
  // inject directly because the fixture doesn't naturally have one; this
  // mirrors what Reformat Section / Add Section produce.
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = '__gitqi-section-hero-styles';
    s.textContent = `[data-zone="hero"] { background: linen; }
#hero h1 { letter-spacing: 0.05em; }`;
    document.head.appendChild(s);
  });

  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await hero.getByRole('button', { name: /Duplicate/ }).click();

  await expect(page.locator('section[data-zone="hero-2"]')).toBeVisible();

  // The clone's style block exists with the new id, and the CSS inside
  // references the new slug — both [data-zone="…"] and #id selectors.
  const styleText = await page.locator('style#__gitqi-section-hero-2-styles').textContent();
  expect(styleText).toContain('[data-zone="hero-2"]');
  expect(styleText).toContain('#hero-2 h1');
  // Original block still has the original slug intact (no in-place mutation).
  const origStyleText = await page.locator('style#__gitqi-section-hero-styles').textContent();
  expect(origStyleText).toContain('[data-zone="hero"]');
});

test('Duplicate Page writes a new file with rewritten title and adds a nav link', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  // Open the Pages panel.
  await page.getByRole('button', { name: 'Pages' }).click();

  // Click the ⧉ Duplicate button on the about.html row. Each row is a
  // <div> that wraps an info <div> + buttons; fileEl is a <div> inside
  // info, so two `..` hops climb back to the row element.
  const aboutRow = page.locator('#__gitqi-pages-panel')
    .getByText('about.html', { exact: false })
    .locator('xpath=../..');
  await aboutRow.getByRole('button', { name: '⧉' }).click();

  // Modal — accept defaults (filename becomes about-copy.html) and submit.
  await page.locator('#__gitqi-dup-fname').fill('services');
  await page.locator('#__gitqi-dup-label').fill('Services');
  await page.locator('#__gitqi-dup-submit').click();

  await waitForDisk(
    page,
    (disk) => disk.has('services.html'),
    { timeout: 10_000 }
  );

  const newPage = await readFakeFile(page, 'services.html');
  // Title was rewritten from the source's "About — GitQi Test Site" to
  // something derived from the new filename (filenameToTitle "services" → "Services").
  expect(newPage).toMatch(/<title>[^<]*Services[^<]*<\/title>/i);

  // Pages inventory got the new entry.
  const inv = JSON.parse(await readFakeFile(page, 'gitqi-pages.json'));
  expect(inv.pages.map((p) => p.file)).toContain('services.html');

  // The CURRENT nav (index.html in the live DOM) gained the new link.
  await expect(page.locator('nav a[href="./services.html"]')).toHaveText('Services');

  // The other page on disk also has the new link (force-sync after duplicate).
  await waitForDisk(
    page,
    (disk) => (disk.read('about.html') || '').includes('services.html'),
    { timeout: 10_000 }
  );
});

test('Duplicate Page rejects a colliding filename', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  await page.getByRole('button', { name: 'Pages' }).click();
  const aboutRow = page.locator('#__gitqi-pages-panel')
    .getByText('about.html', { exact: false })
    .locator('xpath=../..');
  await aboutRow.getByRole('button', { name: '⧉' }).click();

  // Try to overwrite index.html.
  await page.locator('#__gitqi-dup-fname').fill('index');
  await page.locator('#__gitqi-dup-submit').click();

  // Error appears, no new file created.
  await expect(page.locator('#__gitqi-dup-error')).toBeVisible();
  const files = await listFakeFiles(page);
  // No surprise files appeared.
  expect(files).not.toContain('index-2.html');
});
