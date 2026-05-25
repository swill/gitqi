// Reformat Section flow — exercises the Gemini mock end-to-end.
//
// The flow:
//   1. Hover the hero section → "⟳ Reformat" button is revealed.
//   2. Click Reformat → modal appears.
//   3. Fill the description, submit.
//   4. GitQi calls Gemini, parses <section-css> + <section-html>, replaces
//      the section in the DOM, upserts the per-section style block.
//   5. We assert the new content is live and Gemini was called.

const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  configureGemini,
  getGeminiCalls,
} = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

const NEW_SECTION_HTML = `
<section data-zone="hero" data-zone-label="Hero">
  <div class="hero-inner">
    <h1 data-editable>Reformatted Hero</h1>
    <p data-editable>This came back from the Gemini mock.</p>
  </div>
</section>`.trim();

const NEW_SECTION_CSS = `
[data-zone="hero"] .hero-inner { display: flex; flex-direction: column; gap: 1rem; }
[data-zone="hero"] h1 { font-size: 3rem; }`.trim();

test('Reformat Section calls Gemini and swaps in the returned HTML + CSS', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: { geminiKey: 'fake-key' },
    gemini: {
      type: 'section',
      css: NEW_SECTION_CSS,
      html: NEW_SECTION_HTML,
    },
  });

  const heroSection = page.locator('section[data-zone="hero"]');
  await heroSection.hover();

  // The reformat button is created with text "⟳ Reformat". Hover-revealed
  // controls live inside the section — Playwright auto-scrolls + waits for
  // visibility on click, so we don't need an explicit waitFor here.
  await heroSection.getByRole('button', { name: /Reformat/ }).first().click();

  // Modal — fill the description and submit.
  await page.locator('#__gitqi-reformat-desc').fill('Two columns, larger heading');
  await page.locator('#__gitqi-reformat-submit').click();

  // Wait for the swap. The new heading text is the cleanest signal.
  await expect(page.locator('[data-zone="hero"] h1')).toHaveText('Reformatted Hero', {
    timeout: 10_000,
  });

  // Per-section style block was upserted with the slug-prefixed id.
  const styleEl = page.locator('style#__gitqi-section-hero-styles');
  await expect(styleEl).toHaveCount(1);
  const styleText = await styleEl.textContent();
  expect(styleText).toContain('.hero-inner');
  expect(styleText).toContain('font-size: 3rem');

  // Gemini was called exactly once with a prompt that mentions the
  // description from the modal (proves the modal field flows through).
  const calls = await getGeminiCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe('gemini-2.5-flash'); // default model
  expect(calls[0].prompt).toContain('Two columns, larger heading');
});

test('Gemini fallback chain is exercised when the primary model fails', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: { geminiKey: 'fake-key' },
    // Per-call responder: first call fails with 503, second succeeds.
    // Stringified function (sent across the bridge) — cannot close over
    // Node-side vars; use only literals + the `call` argument.
    gemini: function (call) {
      if (call.callIndex === 0) {
        return { status: 503, errorMessage: 'Model overloaded' };
      }
      return {
        type: 'section',
        css: '',
        html: '<section data-zone="hero" data-zone-label="Hero"><h1 data-editable>Fallback Worked</h1></section>',
      };
    },
  });

  const heroSection = page.locator('section[data-zone="hero"]');
  await heroSection.hover();
  await heroSection.getByRole('button', { name: /Reformat/ }).first().click();

  await page.locator('#__gitqi-reformat-desc').fill('anything');
  await page.locator('#__gitqi-reformat-submit').click();

  await expect(page.locator('[data-zone="hero"] h1')).toHaveText('Fallback Worked', {
    timeout: 10_000,
  });

  const calls = await getGeminiCalls(page);
  // First model was tried and failed, fallback model succeeded.
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls[0].model).toBe('gemini-2.5-flash');
  expect(calls[0].responseStatus).toBe(503);
  expect(calls[1].model).not.toBe('gemini-2.5-flash');
  expect(calls[calls.length - 1].responseStatus).toBe(200);
});
