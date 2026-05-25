// Smoke test — the canonical "the harness works" check.
//
// Flow:
//   1. Load the fixture page (fake FSAPI installed pre-navigation).
//   2. Click through the folder-access banner (setupEditor does this).
//   3. Edit the hero <h1> with real keystrokes.
//   4. Wait for the auto-save debounce to fire and write through to the
//      fake disk.
//   5. Assert the file on disk contains the new text AND the dirty
//      indicator has cleared.
//
// If this passes, the full pipeline is wired correctly: page load,
// FSAPI mock, IDB mock, banner click, init(), zone activation,
// contenteditable mutation, MutationObserver, setDirty(), debounced
// saveChanges, writeCurrentPageToLocalFile, and the test-side disk read.

const { test, expect } = require('@playwright/test');
const { setupEditor, readFakeFile, waitForDisk } = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

test('edits to a heading persist to the fake disk', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const heading = page.locator('[data-zone="hero"] h1[data-editable]');
  await expect(heading).toHaveText('Welcome to the Test Site');

  // Edit via real keystrokes — triple-click to select the whole line,
  // then type to replace. This exercises contenteditable + the mutation
  // observer the way a real user would.
  await heading.click({ clickCount: 3 });
  await page.keyboard.type('Hello from Playwright');

  // Wait until auto-save lands the new text into the fake disk file.
  // GitQi's debounce is 1500ms; we poll up to 8s before giving up.
  await waitForDisk(
    page,
    (disk) => {
      const html = disk.read('index.html');
      return html != null && html.includes('Hello from Playwright');
    },
    { timeout: 8_000 }
  );

  const html = await readFakeFile(page, 'index.html');
  expect(html).toContain('Hello from Playwright');
  // Old heading text should be gone.
  expect(html).not.toContain('Welcome to the Test Site');
  // Local-save serialization keeps the script tag so the editor will
  // re-activate on next open. (This guards against accidentally calling
  // serialize({local:false}) on the auto-save path.)
  expect(html).toContain('gitqi.js');

  // Dirty indicator clears after a successful save.
  const dirty = page.locator('#__gitqi-dirty-indicator');
  if (await dirty.count() > 0) {
    await expect(dirty).toBeHidden();
  }
});
