// Selection toolbar — appears on non-empty selection inside [data-editable].
// We cover the two most-used actions: Bold and Link wrap.
//
// Bold uses execCommand('bold') then normalizes <b> → <strong>.
// Link uses execCommand('createLink', '__gitqi_new__'), clears the href,
// and opens the link popover for the user to fill in URL + text.

const { test, expect } = require('@playwright/test');
const { setupEditor } = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

// Programmatic text selection via DOM Selection API — Playwright doesn't
// expose a great primitive for word-level selection inside a specific
// node, but the browser does and it triggers GitQi's mouseup handler
// when we dispatch a synthetic mouseup afterwards.
async function selectTextInParagraph(page, selector, text) {
  await page.evaluate(
    ({ selector, text }) => {
      const para = document.querySelector(selector);
      if (!para) throw new Error('No paragraph for selector: ' + selector);
      // Find text node containing `text`. The paragraph here is a leaf
      // [data-editable] so its child is the text node.
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(text);
        if (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + text.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          // Dispatch mouseup so GitQi's selection handler runs and the
          // floating toolbar appears.
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return;
        }
      }
      throw new Error('Text not found in paragraph: ' + text);
    },
    { selector, text }
  );
}

test('Bold wraps the selection in <strong>', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const paraSelector = 'section[data-zone="hero"] p[data-editable]';
  await selectTextInParagraph(page, paraSelector, 'fixture page');

  await expect(page.locator('#__gitqi-sel-toolbar')).toBeVisible();
  await page.locator('#__gitqi-sel-toolbar button[title="Bold"]').click();

  await expect(page.locator(`${paraSelector} strong`)).toHaveText('fixture page');
});

test('Link wrap creates <a> and opens the link popover', async ({ page }) => {
  await setupEditor(page, FIXTURE);

  const paraSelector = 'section[data-zone="hero"] p[data-editable]';
  await selectTextInParagraph(page, paraSelector, 'fixture page');

  await expect(page.locator('#__gitqi-sel-toolbar')).toBeVisible();
  await page.locator('#__gitqi-sel-toolbar button[title="Link"]').click();

  // The selection toolbar is replaced by the link popover; the new <a>
  // wraps the selected text with href="" (cleared from the __gitqi_new__
  // sentinel).
  await expect(page.locator('#__gitqi-link-popover')).toBeVisible();
  const newLink = page.locator(`${paraSelector} a`).first();
  await expect(newLink).toHaveText('fixture page');

  // Fill in a URL and close.
  await page.locator('#__gitqi-link-url').fill('https://example.com');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(page.locator(`${paraSelector} a[href="https://example.com"]`)).toHaveCount(1);
});
