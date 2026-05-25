// Capability gating — UI features appear / disappear based on which
// secrets are present. Two capability flags drive everything (per
// CLAUDE.md §"Optional Globals"):
//
//   hasGitHub = !!(githubToken && repo)  — Publish button + GitHub uploads
//   hasGemini = !!geminiKey              — AI buttons (Reformat, Add Section, Add Page, Reformat Nav)
//
// Native nav controls and Duplicate Section / Page must work regardless.

const { test, expect } = require('@playwright/test');
const { setupEditor } = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

test('Offline mode hides Publish and AI buttons but keeps native controls', async ({ page }) => {
  // No secrets at all → offline mode.
  await setupEditor(page, FIXTURE);

  const toolbar = page.locator('#__gitqi-toolbar');

  // Publish hidden.
  await expect(toolbar.getByRole('button', { name: 'Publish' })).toHaveCount(0);

  // Export becomes the rightmost CTA in offline mode.
  await expect(toolbar.getByRole('button', { name: 'Export' })).toBeVisible();

  // AI buttons absent: no "+ Add Section" between zones, no "⟳ Reformat Nav"
  // hover button on the nav, no per-section "⟳ Reformat" button.
  await expect(page.locator('.__gitqi-add-wrap')).toHaveCount(0);

  // Hover the nav — Reformat Nav should NOT appear.
  await page.locator('nav').first().hover();
  await expect(page.getByRole('button', { name: /Reformat Nav/ })).toHaveCount(0);

  // Hover a section — Reformat button should NOT appear, but Duplicate
  // and Delete should (those don't need Gemini).
  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await expect(hero.getByRole('button', { name: /^⟳ Reformat$/ })).toHaveCount(0);
  await expect(hero.getByRole('button', { name: /Duplicate/ })).toBeVisible();
  await expect(hero.getByRole('button', { name: /Delete Section/ })).toBeVisible();

  // Native nav controls are present.
  const homeLi = page.locator('nav ul > li').filter({ hasText: 'Home' });
  await homeLi.hover();
  await expect(homeLi.locator('button[title="Move right"]')).toHaveCount(1);
});

test('Gemini-only mode: AI buttons visible, Publish hidden', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: { geminiKey: 'fake-key' },
  });

  const toolbar = page.locator('#__gitqi-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Export' })).toBeVisible();

  // + Add Section buttons exist.
  await expect(page.locator('.__gitqi-add-wrap').first()).toBeAttached();

  // Section Reformat button appears on hover.
  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await expect(hero.getByRole('button', { name: /^⟳ Reformat$/ })).toBeVisible();
});

test('GitHub-only mode: Publish visible, AI buttons hidden', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
  });

  const toolbar = page.locator('#__gitqi-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Publish' })).toBeVisible();

  // No AI machinery.
  await expect(page.locator('.__gitqi-add-wrap')).toHaveCount(0);
  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await expect(hero.getByRole('button', { name: /^⟳ Reformat$/ })).toHaveCount(0);
});

test('Full mode: both Publish and AI features available', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      geminiKey:   'fake-key',
      githubToken: 'fake-token',
      repo:        'testuser/testrepo',
      branch:      'main',
    },
  });

  const toolbar = page.locator('#__gitqi-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Publish' })).toBeVisible();
  await expect(page.locator('.__gitqi-add-wrap').first()).toBeAttached();

  const hero = page.locator('section[data-zone="hero"]');
  await hero.hover();
  await expect(hero.getByRole('button', { name: /^⟳ Reformat$/ })).toBeVisible();
});
