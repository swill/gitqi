// Native nav controls — (+) to add a link in a cluster, ← → to reorder,
// link-popover Remove to drop a link with cross-page sync.
//
// These exist independent of Gemini (offline mode still has full nav
// control). The (+) clones the cluster's last item so CTA-button styling
// is preserved within its cluster; reorder swaps with the previous
// non-editor-UI sibling; remove via popover propagates to other pages.

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

test('Native (+) adds a new nav link by cloning the cluster template', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  // Hover the nav <ul> to reveal the (+) for its cluster.
  const navUl = page.locator('nav ul');
  await navUl.hover();

  // (+) is wrapped in an <li data-gitqi-nav-add="1">. Click the inner button.
  await page.locator('[data-gitqi-nav-add="1"] button, button[data-gitqi-nav-add="1"]').first().click();

  // addNavLinkAfter inserts a "New Link" anchor with href="#" and then
  // opens the link popover. Fill the popover and confirm.
  await expect(page.locator('#__gitqi-link-popover')).toBeVisible();
  await page.locator('#__gitqi-link-text').fill('Services');
  await page.locator('#__gitqi-link-url').fill('services.html');

  // Click outside to dismiss the popover and commit the live edits.
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  // The new link is in the nav after About.
  const items = page.locator('nav ul > li:not([data-editor-ui]) a');
  await expect(items).toHaveText(['Home', 'About', 'Services']);
});

test('→ button reorders nav items', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  // The ← → controls are absolutely positioned ABOVE the li (top:-10px).
  // They hover-fade in via mouseenter on the li — but Playwright's
  // pointer movement to click the button can race with the same li's
  // mouseleave. force:true skips the actionability checks; the click
  // handler still runs the same code path a real user would trigger.
  const homeLi = page.locator('nav ul > li').filter({ hasText: 'Home' });
  await homeLi.hover();
  await homeLi.locator('button[title="Move right"]').click({ force: true });

  const items = page.locator('nav ul > li:not([data-editor-ui]) a');
  await expect(items).toHaveText(['About', 'Home']);
});

test('Link-popover Remove drops the nav link and propagates the removal to other pages', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    diskFiles: {
      'about.html': ABOUT_HTML,
      'gitqi-pages.json': INVENTORY,
    },
  });

  // Click About link to open the popover. Capture-phase link interception
  // intercepts the navigation, so we don't actually navigate.
  await page.locator('nav a[href="about.html"]').click();
  await expect(page.locator('#__gitqi-link-popover')).toBeVisible();

  await page.locator('#__gitqi-link-remove').click();

  // Link gone from the live nav.
  await expect(page.locator('nav a[href="about.html"]')).toHaveCount(0);

  // And the removal propagates to about.html's own file on disk (the page
  // doesn't disappear, only the nav link to it).
  await waitForDisk(
    page,
    (disk) => {
      const html = disk.read('about.html');
      return html != null && !/<nav[^>]*>[\s\S]*<a[^>]*href="about\.html"/.test(html);
    },
    { timeout: 10_000 }
  );
});
