// Shared-head + nav sync — the most coordination-heavy logic in GitQi.
//
// When the user edits the nav / footer / main <style> on page A, GitQi
// snapshots the change and on the next auto-save writes the updated
// element into every other page's file on disk. Active-link markers are
// re-targeted so each destination page marks ITS own current link, not
// the source page's.
//
// These tests load a 2-page fixture (index.html + about.html), edit on
// index, and assert the changes landed in about's file on disk with the
// expected per-page rewrites.

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

test('editing the footer on index.html propagates to about.html on the next save', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  // Sanity: the inventory was loaded (sync needs a multi-page inventory).
  expect(await readFakeFile(page, 'about.html')).toContain('About Us');

  // Edit footer text — that's a shared element, so the snapshot will
  // differ from the baseline and trigger sync on the next auto-save.
  const footerP = page.locator('footer p[data-editable]');
  await footerP.click({ clickCount: 3 });
  await page.keyboard.type('Updated footer 2026');

  // Wait until the propagation has hit about.html on disk.
  await waitForDisk(
    page,
    (disk) => {
      const html = disk.read('about.html');
      return html != null && html.includes('Updated footer 2026');
    },
    { timeout: 10_000 }
  );

  const aboutAfter = await readFakeFile(page, 'about.html');
  expect(aboutAfter).toContain('Updated footer 2026');
  // Original about hero text is preserved — sync only touches shared elements.
  expect(aboutAfter).toContain('About Us');
});

test('active-link marker is retargeted per destination page', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  // Force a shared-element change so sync fires. Touch the footer (cheap).
  const footerP = page.locator('footer p[data-editable]');
  await footerP.click({ clickCount: 3 });
  await page.keyboard.type('Sync trigger');

  await waitForDisk(
    page,
    (disk) => (disk.read('about.html') || '').includes('Sync trigger'),
    { timeout: 10_000 }
  );

  const aboutAfter = await readFakeFile(page, 'about.html');

  // The about.html nav should now mark the About link as active, NOT the
  // Home link — sync uses the source's active CLASS but applies it to the
  // anchor whose href matches the destination's CURRENT_FILENAME.
  // We assert via regex against the serialized HTML so we don't depend
  // on attribute ordering.
  const aboutLinkActive = /<a[^>]*href="about\.html"[^>]*class="[^"]*active/;
  const homeLinkActive  = /<a[^>]*href="index\.html"[^>]*class="[^"]*active/;
  expect(aboutAfter).toMatch(aboutLinkActive);
  expect(aboutAfter).not.toMatch(homeLinkActive);
});

test('main <style> changes propagate to other pages', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  // Mutate a CSS variable on the live page's main style block directly,
  // then trigger an auto-save by changing a shared element. (We don't
  // exercise the Theme editor UI here — that's a separate test in T3 —
  // we just verify that ANY change to the main <style> propagates.)
  await page.evaluate(() => {
    const styles = [...document.querySelectorAll('head > style')];
    // The main style is the one that defines :root vars (per gitqi.js getMainStyleElement)
    const main = styles.find((s) => /:root\s*\{/.test(s.textContent || ''));
    if (!main) throw new Error('Main <style> not found in fixture');
    main.textContent = main.textContent.replace('#1a1b3a', '#ff0000');
  });

  // Touch the footer to trigger a save cycle.
  const footerP = page.locator('footer p[data-editable]');
  await footerP.click({ clickCount: 3 });
  await page.keyboard.type('Trigger sync');

  await waitForDisk(
    page,
    (disk) => {
      const html = disk.read('about.html');
      return html != null && html.includes('#ff0000');
    },
    { timeout: 10_000 }
  );

  const aboutAfter = await readFakeFile(page, 'about.html');
  expect(aboutAfter).toContain('#ff0000');
  // Old value is gone from the propagated main <style>. (We can't simply
  // check the whole file — the old value MAY still appear in non-shared
  // contexts — so we check that the :root block specifically has the new.)
  expect(aboutAfter).toMatch(/:root\s*\{[^}]*#ff0000/);
});
