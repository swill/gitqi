# GitQi — Internals

End-user docs live in `README.md`. This file is for engineers working on `gitqi.js` itself — orientation, non-obvious invariants, and gotchas you can't recover by reading the code.

GitQi is one ~8.6k-line IIFE (`gitqi.js`) that activates on page load when `<script src=".../gitqi.js">` is present. The file you see in the browser is the file on disk — there's no build, no backend, no framework. Edits go through the File System Access API to the local folder, and Publish pushes via the GitHub Contents API.

---

## Capability flags (read once, branched on everywhere)

Computed at load from `window.SITE_SECRETS || {}`:

```js
const hasGitHub = !!(githubToken && repo);  // Publish button + image uploads
const hasGemini = !!geminiKey;              // Reformat Section/Nav + Add Section/Page
```

No query params, no feature flags — secret presence is the only signal. "Offline mode" = both false; folder access via FSAPI is required regardless.

## Init sequence

`init()` at DOMContentLoaded:
1. `loadGoogleFontsManifest()` — sync from `localStorage` cache, background-refresh.
2. `injectToolbar()` → `activateZones()` → `activateNav()`.
3. Bind mutation observer, link interceptor, selection toolbar, undo/redo.
4. `initFileAccess()` — re-link folder from IDB, else show banner.
5. `lastSyncedSharedSnapshot = getSharedSnapshot()` — baseline, so the first auto-save doesn't spuriously sync.

Key constants: `CURRENT_FILENAME` (page basename), `HANDLE_KEY` (`dir:` + site dir URL — shared by all pages in the folder).

---

## Module map

Compact pointer to entry functions per area. Grep these to find the rest.

| Area | Key fns | Notes |
|---|---|---|
| **Zones** (§1) | `activateZones`, `activateZone`, `duplicateSection`, `moveSection` | Footer is pinned: Duplicate + move arrows suppressed |
| **Page Init scanner** (§1a) | `initializePageContent`, `initPageOnDisk`, `runInitOnCurrentPage`, `runInitForPage` | Tags arbitrary HTML; innermost-wins, idempotent |
| **Toolbar** (§2) | `injectToolbar`, `toolbarBtn`, `makeIconButton`, `setDirty` | Shifts body + fixed-nav `top` by 44px |
| **File persistence** (§3) | `initFileAccess`, `writeCurrentPageToLocalFile`, `writeImageToLocalDir`, `openHandleDB` | Handle stored in IDB at `HANDLE_KEY` |
| **Pages inventory** (§4) | `loadPagesInventory`, `savePagesInventory` | `gitqi-pages.json`, auto-seeded |
| **Shared-head sync** (§5) | `syncSharedToOtherPagesIfChanged`, `getSharedSnapshot`, `extractActiveMarker`, `retargetActiveMarker` | See "Sync invariants" below |
| **Mutation observer** (§6) | bound in `init`, ignores `[data-editor-ui]` | 1500ms debounce → `saveChanges()` |
| **Image** (§7) | `bindImageHandler`, `handleImageUpload` | Always `blob:` URL + `data-gitqi-src` |
| **Video** (§7a) | `bindVideoHandler`, `openVideoPopover`, `extractYouTubeId` | YouTube only; 16:9 wrapper is canonical |
| **Selection toolbar** (§8) | `showSelectionToolbar`, `wrapSelectionInStyledSpan`, `clearInlineStyleFromSelection` | Styled spans carry `data-gitqi-style` |
| **Link editor** (§9) | `openLinkPopover`, `parseMailto`, `buildMailto` | Click intercept in capture phase |
| **AI flows** (§10/13) | `promptReformatSection`, `promptAddSection`, `reformatNav`, `generatePage`, `callGeminiWithFallback` | All gated on `hasGemini` |
| **Gemini fallback** (§13a) | `callGeminiWithFallback`, `GEMINI_MODELS`, `RETRYABLE_GEMINI_STATUS` | 429/500/503/504 retry next model |
| **Nav editor** (§11) | `activateNav`, `injectNavControls`, `addLinkToNav`, `prepareClonedNavItem`, `pickMainNavTemplate` | Re-bind must be idempotent |
| **Pages manager** (§12) | `openPagesPanel`, `promptDuplicatePage`, `duplicatePage`, `generatePage`, `deletePageFromSite` |  |
| **Serializer** (§14) | `serialize({local})`, `exportToFile` | `local:true` saves, `local:false` publishes/exports |
| **Email obfuscation** (§14a) | `obfuscateMailtoLinks`, `gqEncode`, decoder script `[data-gqe-decoder]` | Publish-output only |
| **GitHub publisher** (§15) | `publishSite`, `github.{getFileSHA,putFile,uploadFile,deleteFile,listDirectory}` | Gated on `hasGitHub` |
| **Undo / redo** (§16) | `snapshotForUndo`, `captureSnapshot`, `restoreSnapshot`, `UNDO_LIMIT = 20` | Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z |
| **Theme** (§17) | `openThemeEditor`, `makeVarRow`, `updateStyleVar`, `addStyleVar`, `parseCSSVars` |  |
| **Asset cleanup** (§17a) | `promptAssetCleanup`, `collectAssetReferences`, `enumerateLocalAssets`, `enumerateRemoteAssets`, `runAssetCleanup` |  |
| **Google Fonts** (§18) | `loadGoogleFontsManifest`, `ensureGoogleFontLink`, `openFontPreviewer`, `pruneUnusedGoogleFontLinks` |  |
| **DOM helpers** (§19) | `rerunInlineScripts`, `el`, `css` | `rerunInlineScripts` after nav replacement |

---

## Sync invariants (the most coordination-heavy logic)

`syncSharedToOtherPagesIfChanged()` writes the current page's shared elements into every other page on disk. Runs on every auto-save when the snapshot differs from `lastSyncedSharedSnapshot`. Also force-triggered (by resetting the snapshot to `''`) after Reformat Nav, Add Page, Duplicate Page, Delete Page, native nav add/move/remove, and link-popover Remove in a nav.

**Synced** (whole-site):
- `<nav>` — verbatim, except the active-link marker is retargeted per page
- `<footer>` (or `[data-zone="footer"]`) — verbatim, no retargeting
- Main `<style>` (the one with `:root { ... }` — Theme edits live here)
- `<style id="__gitqi-nav-styles">`
- `<style id="__gitqi-section-{footerSlug}-styles">` (when footer has a zone slug)
- Favicon `<link rel="icon">` + `apple-touch-icon`
- Google Fonts `<link>`s (incl. preconnects)

**NOT synced** (intentionally per-page): `<title>`, `<meta name="description">`, `<meta name="keywords">`.

**Active marker** (`ACTIVE_CLASS_CANDIDATES`): classes `active` / `current` / `is-active` / `is-current` / `selected`, plus `aria-current`. `extractActiveMarker` reads whichever the source's anchor-for-this-page has; `retargetActiveMarker` strips them all from the cloned nav and re-applies to the destination's matching anchor. Falls back to the destination's own existing marker if the source has none, so a transient nav state doesn't wipe markers everywhere.

A bare `<footer>` (no `data-zone`) gets synced but does NOT get section controls (those bind via `activateZone`, which requires `[data-zone]`).

---

## Serializer invariants

`serialize({local})` clones `<html>` and strips. Both modes remove `[data-editor-ui]`, `contenteditable`, `spellcheck`, GitQi binding markers (`data-gitqi-bound`, `data-gitqi-nav-bound`, `data-gitqi-nav-item-bound`, `data-gitqi-video-bound`), resolve `img[data-gitqi-src]` blob URLs back to `./assets/...`, strip any inline `style` on `<html>`, and restore the body/nav top offsets the toolbar shifted.

**`local: false` additionally:**
- Strips `<script src="…secrets.js">` and `<script src="…gitqi.js">`.
- Strips `data-gitqi-style` markers (inline styles preserved).
- Runs `obfuscateMailtoLinks(clone)`.

`publishSite` reads OTHER pages from disk (last saved with `local: true`), so it must re-strip script tags, `data-gitqi-style`, and run mailto obfuscation per page in its own pass — those didn't go through `serialize({local: false})`. Helpers use `node.ownerDocument` so they work across parsed docs.

**Email obfuscation:** per `<a href="mailto:…">`, the URL is encoded into `data-gqe` and the href becomes `javascript:void(0)`. Text-node occurrences of the address inside the link become `<span data-gqt="…">` placeholders (case preserved). One decoder script `[data-gqe-decoder]` is appended per body. No `<noscript>` fallback — that would defeat the protection.

---

## Gotchas / non-obvious invariants

**`hasGitHub` and `hasGemini` are computed once at load.** Toggling secrets at runtime won't change which UI is rendered. Tests that need a different capability set must navigate fresh with different `SITE_SECRETS`.

**Mutation observer ignores `[data-editor-ui]`.** Anything the editor injects must carry that attribute or it'll trigger a dirty save loop.

**Auto-save debounce is 1500ms.** Tests should poll the fake disk via `waitForDisk` rather than `waitForTimeout(1500)`.

**Snapshot baseline trick.** `init()` sets `lastSyncedSharedSnapshot = getSharedSnapshot()` after activation so the first save doesn't trigger a no-op sync. Code paths that force sync set it to `''` first.

**Section duplicate CSS rewrite is fragile by design.** `rewriteSectionCssSlug` does textual `[data-zone="…"]` and `#…` substitution. It doesn't understand `:where()`, attribute-substring matchers (`[data-zone^=…]`), or class names that embed the slug. When it breaks subtly, a Reformat on the new section fixes it.

**Nav re-bind must clean up first.** `injectNavControls` strips all `[data-gitqi-nav-add]` placeholders and clears `[data-gitqi-nav-item-bound]` markers + their editor-UI children before rebinding. Otherwise placeholders accumulate and items stay "already bound" so their ← → controls never appear.

**`addLinkToNav` clusters by class signature.** Items are grouped by combined wrapper + inner-anchor classes. Programmatic adds (from `generatePage` / `duplicatePage`) clone from the *largest* cluster via `pickMainNavTemplate` so a new "main page" link doesn't inherit CTA-button styling. Insertion lands before any trailing `data-editor-ui` placeholder.

**Hamburger script pattern.** Inline nav scripts should bind to the `<nav>` element, NOT `document` or `window`, so listeners disappear when the nav is replaced and re-attach when `rerunInlineScripts` re-executes them:

```js
(function() {
  const nav = document.currentScript.closest('nav');
  nav.addEventListener('click', e => { /* … */ });
})();
```

**Inline `<script>` execution.** Scripts inserted via `innerHTML`/`replaceWith` are inert. `rerunInlineScripts(el)` replaces every script node with a fresh element to force execution — called after nav replacement (`reformatNav`, `restoreSnapshot`).

**Image upload always uses a blob URL.** Replacing an image with a new file of the same name leaves the relative path unchanged; reassigning `img.src` to the same string shows browser-cached old bytes. The serializer resolves `data-gitqi-src` back on save/publish.

**Selection toolbar styled spans use a full-coverage guard.** `wrapSelectionInStyledSpan(prop, val)` only strips an existing style from a `<span>` if the selection covers ALL of that span's contents — protects hand-authored markup that extends beyond the selection. Explicit "Remove color" / "Normal" / "Clear font" drop the guard.

**`data-gitqi-style` marker survives local saves and snapshots.** Stripped only in `serialize({local: false})`. This lets re-opens and undo/redo round-trip styled spans correctly.

**Link Remove is context-aware.** In a nav: drop the `<li>` and force sync. Inside `[contenteditable]` (= inside a `[data-editable]` zone): UNWRAP the `<a>` so sentence text keeps flowing. Outside any editable host (e.g. CTA in a structural wrapper): drop the whole `<a>`.

**`mailto:` popover Subject/Body roundtrip.** `parseMailto` reads `?subject=` / `?body=` on open; editing either field rebuilds the URL via `buildMailto`. A `suppressUrlSync` flag breaks the URL→inputs→URL feedback loop.

**YouTube canonical markup.** `<div data-editable-video style="…56.25%…"><iframe src="https://www.youtube.com/embed/{ID}">`. The wrapper owns the click (iframes swallow events). The placeholder ID `M7lc1UVf-VE` is Google's own demo video. Domain is `youtube.com` not `youtube-nocookie.com` (latter looks alien in the edit popover and doesn't fix Error 153 anyway). On `file://`, Error 153 blocks playback — a "Preview only" pill warns the user.

**Page Init: innermost-wins.** `selectInnermostZones` skips a candidate that contains other candidates, so a `<main>` wrapping `<section>`s yields the sections as zones, not the main. Avoids nested `[data-zone]`. Zone allowlist: `section`, `header`, `footer`, `main`, `article`.

**Page Init is idempotent.** Every check is "skip if already tagged." Stats distinguish `zonesAdded` from `zonesSkipped` so the UI says "Nothing new to init" appropriately. `initPageOnDisk` skips the write when stats are zero so re-init on a tagged file is a no-op in git.

**Gemini fallback chain.** `gemini-2.5-flash` → `gemini-2.5-pro` → `gemini-2.0-flash` → `gemini-flash-latest` → `gemini-2.5-flash-lite`. Each AI Studio model has independent quota, so 429 fallback works. `sessionPreferredModel` becomes sticky once a fallback succeeds. `opts.model` override (from the error UI) disables fallback for that call. Retryable statuses: 429/500/503/504.

**Asset cleanup errs toward false-positives.** `ASSET_REF_RE = /assets\/([^\s"'\`)<>?#,]+)/gi` plus a DOM walk. Sources include the live document, `serialize({local: true})` of the current page, every other inventory page parsed via `DOMParser`, and `gitqi-pages.json`. False-positives just add a checkbox to uncheck; false-negatives would break the live site by deleting referenced assets.

**Asset cleanup is idempotent across partial failures.** `github.deleteFile` and `github.listDirectory` treat 404 as a no-op.

**Font pruning runs every save.** `pruneUnusedGoogleFontLinks` scans main/nav/per-section styles for `font-family:` and `--font-*`; any unreferenced Google Fonts `<link>` is removed (preconnects too when the last stylesheet goes). Cleanup then syncs to other pages.

**GitHub PUT collisions.** On 409 for the current page, `publishSite` silently swallows the error. Other pages with errors surface in the status message.

---

## Required CSS variables

AI-generated sections/pages reference these by name; the Theme editor exposes them as grouped controls. Minimum set: `--color-{primary,secondary,accent,bg,bg-alt,text,text-muted}`, `--font-{heading,body}`, `--font-size-base`, `--line-height-base`, `--space-{xs,sm,md,lg,xl}`, `--container-width`, `--radius`, `--shadow`. See `tests/fixtures/site/index.html` for a canonical block.

**GitQi-managed style blocks:**
- `<style id="__gitqi-nav-styles">` — written by Reformat Nav.
- `<style id="__gitqi-section-{slug}-styles">` — written by section Reformat / Add Section. Duplicate clones with regex slug rewrites.

---

## Testing

Full setup + invocation docs in `README.md` (Development → Testing). Below is the API surface you need when writing tests.

E2E suite uses Playwright + Chromium in a Docker container. Real `gitqi.js` runs against fixture pages; only the FSAPI boundary (and `fetch` to Gemini/GitHub) is faked. Layout:

```
tests/
├── playwright.config.cjs
├── e2e/*.spec.js              ← auto-discovered
├── helpers/
│   ├── fake-fs.js             ← installs in-browser FSAPI + IDB fake
│   ├── api-mocks.js           ← installs in-browser fetch interceptor
│   └── setup.js               ← test-side helpers
└── fixtures/
    ├── site/{index,about}.html
    ├── bare/index.html        ← no markers, for Init Page tests
    └── links/index.html       ← mailto + CTA + inline link, for popover tests
```

### Test-side API (`require('../helpers/setup')`)

```js
await setupEditor(page, '/tests/fixtures/site/index.html', {
  diskFiles: { 'about.html': '…', 'gitqi-pages.json': '…' },  // optional pre-seed
  secrets:   { geminiKey: 'k', githubToken: 't', repo: 'u/r' }, // optional
  gemini:    { type: 'section', css: '…', html: '…' },        // or a function (see below)
  github:    { initialFiles: { 'index.html': '…' } },
});

// Disk
await readFakeFile(page, 'index.html');
await listFakeFiles(page);
await waitForDisk(page, disk => disk.read('about.html')?.includes('x'));

// GitHub
await readGitHubFile(page, 'index.html');
await getGitHubRepo(page);                  // { path: stringContent }
await getGitHubCalls(page);                 // [{ method, path, responseStatus }]
await waitForGitHub(page, repo => repo.has('index.html'));

// Gemini
await configureGemini(page, spec);          // reconfigure mid-test
await getGeminiCalls(page);                 // [{ model, prompt, callIndex, responseStatus, responseText }]
```

In the browser: `window.__fakeDisk.{read,readBytes,list,has,write,delete,clear}`, `window.__githubRepo.{read,list,has,sha,put,delete,clear}`, `window.__fetchLog`.

### Gemini mock spec shapes

```js
{ type: 'section', css: '…', html: '…' }   // <section-css>…</section-css><section-html>…</section-html>
{ type: 'nav',     html: '…', css: '…' }   // <nav-html>…</nav-html><nav-css>…</nav-css>
{ type: 'page',    html: '<!DOCTYPE…>' }    // full doc for Add Page
{ text: '…' }                               // raw response text
{ status: 503, errorMessage: '…' }          // failure simulation
```

Per-call responder: pass a `function ({ prompt, model, callIndex }) → spec`. Stringified to the browser, so **no closures over Node-side variables**.

### GitHub mock behavior

In-memory repo seeded by `initialFiles`. From then on, GitQi's real `getFileSHA → putFile(sha)` flow runs. Mock returns:
- GET on file → 200 with sha + base64 content (404 if absent)
- GET on dir → array of `{ name, path, sha, type }`
- PUT to existing file without `sha` → 409 (matches real GitHub)
- PUT with stale `sha` → 409 (tests can simulate by mutating `__githubRepo` between GET and PUT)
- DELETE → 200 on match, 404 if missing

### What's NOT tested

Chrome's FSAPI implementation, permission UX (gesture prompts, revocation), IDB internals, and Tier 4 surfaces (selection-toolbar color/font flyouts, Google Fonts picker UI, video manager, favicon upload). Run manually against a real folder when those areas change.

### Patterns to watch for

- Hover-revealed controls (section/nav buttons positioned at top:-10px) race with mouseleave when Playwright moves the pointer. Use `{ force: true }` on the click after a `hover()`.
- For Pages-panel row buttons: each row has a file name in a leaf `<div>` inside an info `<div>` inside the row `<div>`. `.getByText('about.html').locator('xpath=../..')` reaches the row.
- `URLSearchParams` encodes spaces as `+`, not `%20`. Parse mailto query strings via `new URLSearchParams(url.split('?')[1])` to assert intent.

---

## Non-goals

- Multi-user editing or auth.
- Version history UI (git is the version history).
- Any server-side component.
