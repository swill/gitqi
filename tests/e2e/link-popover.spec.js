// Link popover — three Remove branches + mailto subject/body roundtrip.
//
// Remove behavior depends on context (per §9):
//   • Inside a nav: drop the wrapping <li> (covered by nav-native.spec)
//   • Inside [contenteditable] (= inside [data-editable]): UNWRAP — keep text
//   • Outside any editable host (e.g. CTA button): DROP the whole <a>
//
// Mailto: parseMailto reads ?subject= / ?body= into the inputs on open;
// editing them rebuilds the URL via buildMailto. We exercise both
// directions.

const { test, expect } = require('@playwright/test');
const { setupEditor } = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/links/index.html';

test('Editing URL in the popover updates the live href', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  await page.locator('p[data-editable] a[href="https://example.com"]').click();
  await expect(page.locator('#__gitqi-link-popover')).toBeVisible();

  await page.locator('#__gitqi-link-url').fill('https://updated.example.com');

  // The popover writes live as you type; close it by clicking outside.
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  await expect(page.locator('p[data-editable] a[href="https://updated.example.com"]')).toHaveCount(1);
});

test('Mailto popover reads subject/body on open and rewrites the URL on edit', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  await page.locator('a[href^="mailto:"]').click();
  await expect(page.locator('#__gitqi-link-popover')).toBeVisible();

  // Existing subject + body were parsed from the URL.
  await expect(page.locator('#__gitqi-link-subject')).toHaveValue('Hi');
  await expect(page.locator('#__gitqi-link-body')).toHaveValue('Hello there');

  // Change subject — URL rebuild fires on input.
  await page.locator('#__gitqi-link-subject').fill('Updated subject');

  // URL input should now reflect the new subject. URLSearchParams encodes
  // spaces as '+' in query strings (and decodeURIComponent doesn't undo
  // that), so we parse via URLSearchParams to assert intent rather than
  // exact serialization.
  const url = await page.locator('#__gitqi-link-url').inputValue();
  expect(url).toMatch(/^mailto:hello@example\.com\?/);
  const qs = new URLSearchParams(url.split('?')[1]);
  expect(qs.get('subject')).toBe('Updated subject');
  expect(qs.get('body')).toBe('Hello there');
});

test('Remove link inside an editable paragraph UNWRAPS the anchor', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  await page.locator('p[data-editable] a[href="https://example.com"]').click();
  await page.locator('#__gitqi-link-remove').click();

  // <a> is gone, but the visible text "our site" is preserved as a text node.
  await expect(page.locator('p[data-editable] a[href="https://example.com"]')).toHaveCount(0);
  const paraText = await page.locator('p[data-editable]').first().textContent();
  expect(paraText).toContain('our site');
});

test('Remove link on a non-editable CTA drops the whole anchor', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  await page.locator('a.cta').click();
  await page.locator('#__gitqi-link-remove').click();

  // Anchor is fully removed (no orphan text node left behind, since the
  // .cta-wrap parent isn't editable so a stray text node would be
  // unreachable to the user).
  await expect(page.locator('a.cta')).toHaveCount(0);
  await expect(page.locator('.cta-wrap')).not.toContainText('Sign up now');
});
