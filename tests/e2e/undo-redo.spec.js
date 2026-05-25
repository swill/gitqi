// Undo / redo across structural changes.
//
// GitQi snapshots the body + GitQi-owned style blocks before any
// structural mutation, so Ctrl+Z reverses delete / duplicate / move /
// reformat / nav-edit / image-replace / etc. Text edits use the
// browser's native contenteditable undo and are intentionally NOT
// covered here.

const { test, expect } = require('@playwright/test');
const { setupEditor } = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

test('Ctrl+Z restores a deleted section', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const about = page.locator('section[data-zone="about"]');
  await expect(about).toBeVisible();

  // Hover to reveal the controls, then click the delete button.
  await about.hover();
  await about.getByRole('button', { name: /Delete Section/ }).click();

  // Confirm dialog — click the destructive button.
  await page.locator('[data-role="confirm"]').click();

  await expect(about).toHaveCount(0);

  // Ctrl+Z restores. Keyboard binding is bound on document, so we don't
  // need to focus a specific element.
  await page.keyboard.press('Control+z');

  await expect(page.locator('section[data-zone="about"]')).toBeVisible();
  await expect(page.locator('section[data-zone="about"] h2[data-editable]')).toHaveText('About');
});

test('Ctrl+Y / Ctrl+Shift+Z replays the undone change', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const about = page.locator('section[data-zone="about"]');
  await about.hover();
  await about.getByRole('button', { name: /Delete Section/ }).click();
  await page.locator('[data-role="confirm"]').click();

  await page.keyboard.press('Control+z');
  await expect(page.locator('section[data-zone="about"]')).toBeVisible();

  // Redo — Ctrl+Y (and Ctrl+Shift+Z both work; we test the more common one).
  await page.keyboard.press('Control+y');
  await expect(page.locator('section[data-zone="about"]')).toHaveCount(0);
});

test('Undo reverses Duplicate Section', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  // One hero to start.
  await expect(page.locator('section[data-zone^="hero"]')).toHaveCount(1);

  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await hero.getByRole('button', { name: /Duplicate/ }).click();

  // After duplicate, a new section appears with a -2 suffix.
  await expect(page.locator('section[data-zone^="hero"]')).toHaveCount(2);
  await expect(page.locator('section[data-zone="hero-2"]')).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(page.locator('section[data-zone^="hero"]')).toHaveCount(1);
  await expect(page.locator('section[data-zone="hero-2"]')).toHaveCount(0);
});

test('Toolbar ↩ button performs the same undo as the keyboard shortcut', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const about = page.locator('section[data-zone="about"]');
  await about.hover();
  await about.getByRole('button', { name: /Delete Section/ }).click();
  await page.locator('[data-role="confirm"]').click();
  await expect(about).toHaveCount(0);

  // The toolbar undo button uses the ↩ glyph. Use exact match because
  // many buttons start with arrows.
  await page.locator('#__gitqi-toolbar').getByRole('button', { name: '↩' }).click();
  await expect(page.locator('section[data-zone="about"]')).toBeVisible();
});
