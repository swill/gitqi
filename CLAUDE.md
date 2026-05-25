# GitQi - Site Editor — Project Architecture

## Overview

A zero-dependency, browser-based inline editing system for static websites. The site owner opens their HTML files locally, edits content in-place, and publishes directly to GitHub Pages — no terminal, no CMS, no backend.

The system has two distinct modes:
- **Edit mode** — `gitqi.js` is included in the HTML and the editor activates as soon as the page loads. Features degrade per-capability based on what's in `secrets.js`:
  - `githubToken` + `repo` present → **Publish** button + GitHub image uploads
  - `geminiKey` present → AI features (Reformat Section, Reformat Nav, Add Section, Add Page)
  - both absent ("offline mode") → in-place edits, native nav controls (+ / ← →), Duplicate Page, ⟲ Sync, Theme, Export. Folder access via the File System Access API is still required regardless.
- **Public mode** — the deployed site with no editor code, no credentials, no overhead

There is **no query parameter or feature flag** for offline mode. Presence of each secret is the only signal; the editor sets `hasGitHub` and `hasGemini` flags once at load and the rest of the code branches on those.

---

## Structure

### Local folder (on the site owner's computer)

```
my-site/
├── index.html          ← Main page; content + CSS vars + structure
├── about.html          ← Additional pages (multi-page sites)
├── gitqi-pages.json    ← Page inventory, auto-managed by GitQi
├── secrets.js          ← Never published. Sets window.SITE_SECRETS
└── assets/
    └── *.jpg / *.png
```

This folder is **not** a git repository. GitQi publishes HTML files and uploads images directly to GitHub via the REST API. `secrets.js` never leaves the local machine.

### Remote GitHub repository

```
username/repo-name  (GitHub)
├── index.html
├── about.html
├── gitqi-pages.json
└── assets/
    └── *.jpg / *.png
```

GitHub Pages is configured to serve from the root of the `main` branch ("Deploy from branch → main → / (root)"). Any push — including GitQi's API commits — updates the live site automatically. No GitHub Actions workflow is required.

---

## The Editor Script (`gitqi.js`)

Single self-invoking IIFE, hosted externally on GitHub Pages. Included in each HTML page only during local editing — stripped from the published output.

### Optional Globals (set by `secrets.js`)

All fields are optional — `secrets.js` may itself be absent. The editor still loads; features gate on what's available.

```js
window.SITE_SECRETS = {
  geminiKey:   "AIza...",   // Google AI Studio API key — free at aistudio.google.com
  githubToken: "ghp_...",   // Fine-grained PAT: contents read+write on the site repo
  repo:        "user/repo", // e.g. "jane/jane-osteopathy"
  branch:      "main"       // Deployment branch
};
```

`gitqi.js` reads `window.SITE_SECRETS || {}` and computes two capability flags consumed throughout the file:

```js
const hasGitHub = !!(githubToken && repo);  // gates Publish button + image uploads + favicon upload
const hasGemini = !!geminiKey;              // gates all four AI flows + their entry-point buttons
```

### Initialization

`init()` runs once at DOMContentLoaded:

1. `loadGoogleFontsManifest()` — install cached manifest synchronously; background-fetch fresh
2. `injectToolbar()` → `activateZones()` → `activateNav()`
3. Bind: mutation observer, link handlers, selection toolbar, undo/redo
4. `initFileAccess()` — re-link the site folder if a handle is in IndexedDB; otherwise show the folder-picker banner
5. `lastSyncedSharedSnapshot = getSharedSnapshot()` — baseline so the first auto-save doesn't spuriously sync

### Key Constants

```js
const CURRENT_FILENAME = location.pathname.split('/').pop() || 'index.html';
const HANDLE_KEY = 'dir:' + location.href.substring(0, location.href.lastIndexOf('/') + 1);
// Keyed by site directory (not page path) so all pages in the same folder share one handle
```

---

## Core Modules

### 1. Zone Manager

Identifies and activates editable regions.

**Data attributes:**

| Attribute | Purpose |
|---|---|
| `data-zone` | Marks a top-level editable section (e.g. `"hero"`, `"about"`). Also set as the element `id` for anchor links. |
| `data-zone-label` | Human-readable label shown in the delete confirmation |
| `data-editable` | Text node is directly editable via `contenteditable` |
| `data-editable-image` | Image can be replaced by clicking |
| `data-editable-video` | `<div>` wrapper around a YouTube `<iframe>` — clicking opens a URL popover that swaps the video |

`activateZones()` queries `[data-zone]`, calls `activateZone(section)` for each, then injects "+ Add Section" buttons between zones. `activateZone` makes `[data-editable]` children contenteditable, binds image and video handlers, sets the section's `id` from its `data-zone` slug, and injects the section controls (see below).

**Section controls** — hover-revealed buttons added by `activateZone`:

- Right side, in a single right-aligned flex container (`getOrCreateRightControls(section)` for consistent spacing): **⧉ Duplicate**, **⟳ Reformat**, **✕ Delete**.
- Left side, in their own flex container: **↑ / ↓** move arrows (with a 1px `T.accent4` border so they stand out on dark backgrounds).
- The footer (whatever `getFooterElement()` matches) is suppressed from Duplicate and the move arrows — it's pinned at the bottom and is replicated across pages by the shared sync, so duplicating or moving it would produce broken state. Reformat and Delete still apply.

**Duplicate** (`duplicateSection`): clones the section, generates a unique zone slug via `generateUniqueZoneSlug` (suffix `-2`, `-3`, … starting from the base or incrementing if already suffixed), drops descendant `id` attributes to avoid collisions, clears runtime markers (`data-editor-ui`, `data-gitqi-bound`, `data-gitqi-video-bound`, `contenteditable`, `spellcheck`), and clones the per-section style block under the new id. CSS is rewritten textually via `rewriteSectionCssSlug` for `[data-zone="…"]` and `#…` references — fragile by design (regex-on-CSS doesn't understand `:where()`, attribute-substring matchers, or class names that happen to embed the slug). When something subtle breaks, a Reformat on the new section fixes it.

**Move** (`moveSection`): reorders within sibling `[data-zone]` elements, with the footer pinned in place. Captures undo, scrolls the moved section into view (`block: 'nearest'`), and calls `refreshAddButtons()` to keep "+ Add Section" markers consistent.

### 1a. Page Init Scanner

`initializePageContent(rootEl)` walks a DOM root and injects the `data-*` markers GitQi needs so the editor can manage an arbitrary HTML page. Two surfaces:

- **Live DOM** — `runInitOnCurrentPage()` (gear menu, or Pages-panel ✨ on the current row): snapshots, scans `document.body`, re-runs `activateZones() + activateNav()`, marks dirty so auto-save persists the tagging.
- **Disk doc** — `initPageOnDisk(page)` reads the file, parses with `DOMParser`, scans, and writes back only when stats are non-zero (so a re-init on an already-tagged file is a no-op in git). Surfaced as the per-row ✨ for non-current pages; `runInitForPage(page)` dispatches between the two paths by `page.file === CURRENT_FILENAME`.

**Zone allowlist** (`INIT_ZONE_TAGS`): `section`, `header`, `footer`, `main`, `article`. Plain `<div>` is never auto-tagged — wrap in `<section>` or use AI-Reformat. **Innermost-wins** (`selectInnermostZones`) skips outer candidates that contain inner ones, so a `<main>` wrapping `<section>`s yields the sections as zones, not the main. Avoids nested `[data-zone]`.

**Slug priority** (`pickZoneSlug`): existing `id` → canonical name for `header`/`footer`/`main` → first descendant heading slug → tag name + numeric fallback. Collisions walk `-2, -3, …` against a per-scan `taken` set, so a disk-doc scan never collides with live-page slugs.

**Editable rules** (`tagEditablesInZone`) — `h1-h6 / p / li / a` inside a zone get `data-editable`, with skip conditions for: already tagged, inside editor UI or `<nav>` or `[data-editable-video]`, has an editable ancestor up to the zone, has a disallowed block child (`INIT_BLOCK_CHILD_TAGS`). Anchors additionally require text content and no `<img>`/`<iframe>`/`<svg>` child (`isAnchorEditableCandidate`) — anchor-wrapped images stay untagged; the link popover still works via click intercept.

**Images** — every `<img>` in a zone (not inside `[data-editor-ui]`) gets `data-editable-image`. `activateZone` binds every `<img>` regardless of the marker, but tagging keeps the data model self-describing for AI prompts.

**YouTube embeds** (`wrapVideosInZone`) — `<iframe>` whose `src` matches YouTube gets a `[data-editable-video]` wrapper. If the iframe's parent is a single-child `<div>` (existing aspect-ratio wrapper), promote it; otherwise wrap in a fresh 16:9 container. Non-YouTube iframes are left alone.

**Idempotent** — every check is "skip if already tagged." Stats distinguish `zonesAdded` from `zonesSkipped` so the UI says "Nothing new to init" when appropriate.

### 2. Toolbar

Fixed-position bar prepended to the page in edit mode. Marked `data-editor-ui` so it's stripped on export/publish.

Left → right: site title with `●` dirty indicator, status message area, **↩ Undo**, **↪ Redo**, **⟲ Sync**, **Pages**, **Theme**, **Export**, **Publish**, **⚙** (site utilities), **?** (help, rightmost).

- **⟲ Sync** — manual trigger for `syncSharedToOtherPagesIfChanged()`. Resets `lastSyncedSharedSnapshot` first so it always runs, then surfaces a status like "Synced shared elements to N other page(s) ✓". Use case: hand-editing nav/footer HTML on disk and wanting to force-propagate without making a trivial dirty edit just to trigger auto-save.
- **Export** — `serialize({ local: false })` + download. Becomes the visual CTA (styled primary) when Publish is hidden in offline mode.
- **Publish** — only present when `hasGitHub`. Commits all pages + `gitqi-pages.json` to GitHub.
- **⚙** — always present. Opens the Site Utilities side panel: capability/folder status, **Re-link folder** (opens a confirm-style modal via `promptRelinkFolder()` that mirrors the initial folder-access banner — accent stripe, current-folder hint, location hint, explanation of what will change — then replaces the stored handle, refreshes inventory, resets shared snapshot), **✨ Init this page** (see §1a), and **🧹 Clean up unused assets** (relocated from the Theme panel). Mutually exclusive with the other side panels via `closeSidePanels(exceptId)`.
- **?** — always present. Opens the Help side panel: keyboard shortcuts, capability summary, and a "Currently unavailable" block listing missing features and how to enable them (links to AI Studio for Gemini, fine-grained-PAT instructions for GitHub). Each missing capability has its own `note:` line: Gemini-missing mentions native nav controls + duplicate-as-template; GitHub-missing mentions Export + local `assets/`.

The ⚙ and ? buttons share a `makeIconButton(text, title)` helper so they stay visually identical.

`injectToolbar()` shifts `body { padding-top }` and any fixed `<nav>`'s `top` down by 44px to make room. `setDirty(bool)` toggles the indicator and schedules a debounced auto-save (1500ms).

**Auto-save sync messaging** — `saveChanges()` reads the result object from `syncSharedToOtherPagesIfChanged()` (`{ skipped, syncedCount, failedFiles }`) and surfaces "Synced shared elements to N other page(s) ✓" whenever it actually propagates anything. Silent when there was nothing to sync. The same function is called by the manual ⟲ button which always emits a status.

### 3. File Persistence

Keeps HTML files on disk in sync with the live DOM via the File System Access API. Chrome / Edge only — other browsers see a blocking modal.

- `initFileAccess()`: load `FileSystemDirectoryHandle` from IndexedDB, verify permission, silently re-link or show the folder banner.
- `saveChanges()` (auto-save): `writeCurrentPageToLocalFile()` then `syncSharedToOtherPagesIfChanged()`.
- `serialize({ local: true })` keeps the `secrets.js` and `gitqi.js` script tags so edit mode activates on next open. `local: false` strips them for published output.
- Image upload: `writeImageToLocalDir(file)` writes to `assets/` and the serializer resolves any `data-gitqi-src` blob-URL placeholders back to relative paths on publish.

### 4. Pages Inventory

`gitqi-pages.json` alongside the HTML files:

```json
{ "pages": [{ "file": "index.html", "title": "Home", "navLabel": "Home" }, ...] }
```

Auto-created on first use. `loadPagesInventory()` reads it (seeding from the current page if missing) and ensures `CURRENT_FILENAME` is registered.

### 5. Shared Head + Nav Sync

On every auto-save, compares a JSON snapshot of the current page's shared head + nav against the last-synced snapshot. If anything changed, the updated elements are written into every other page file on disk. Triggered immediately (not via the auto-save timer) after Reformat Nav, Add Page, **Duplicate Page**, Delete Page, **native nav add/move/remove link, and link-popover Remove link in a nav** (all reset `lastSyncedSharedSnapshot = ''` and call the sync directly — or rely on the next auto-save to pick the change up). The toolbar **⟲ Sync** button does the same: reset snapshot, call sync, always emit a status.

`syncSharedToOtherPagesIfChanged()` returns `{ skipped, reason }` or `{ skipped: false, syncedCount, failedFiles }`. `saveChanges()` reads this and surfaces "Synced shared elements to N other page(s) ✓" when `syncedCount > 0`, staying silent otherwise. `manualSync()` always emits a status — either the success count, "Nothing to sync — only one page", or a failure summary.

**Synced** (page-to-page, whole-site):
- `<nav>`
- `<footer>` (falling back to `[data-zone="footer"]`) — copied verbatim; no active-marker retargeting since footers don't typically have per-page "current" state. **A bare `<footer>` (no `data-zone`, no `data-editable`) gets synced too, but doesn't get the section controls** because those bind through `activateZone()` which only runs on `[data-zone]` elements.
- Main `<style>` (CSS variables + base styles, edited via the Theme panel)
- `<style id="__gitqi-nav-styles">` (nav-specific CSS)
- `<style id="__gitqi-section-{footerSlug}-styles">` — the footer's per-section style block, when the footer has `data-zone`
- `<link rel="icon">` and `<link rel="apple-touch-icon">` (favicon)
- Google Fonts `<link>`s matching `fonts.googleapis.com` or `fonts.gstatic.com` (including preconnects)

**NOT synced** (intentionally page-specific): `<title>`, `<meta name="description">`, `<meta name="keywords">`.

**Active-link retargeting** — the sync copies the source nav verbatim but rewrites the "current page" marker for each destination. Recognised markers (`ACTIVE_CLASS_CANDIDATES`): CSS classes `active`, `current`, `is-active`, `is-current`, `selected`, plus the `aria-current` attribute. `extractActiveMarker()` reads whichever are present on the source's anchor matching `CURRENT_FILENAME`; `retargetActiveMarker()` strips them all from the cloned nav and re-applies them to anchors whose `href` matches the destination page.

### 6. Mutation Observer

Subtree observer on `<body>` for `characterData` + `childList`. Mutations originating from `[data-editor-ui]` are ignored. Anything else triggers `setDirty(true)` → debounced auto-save. Disconnected and re-bound on undo/redo (and any other mass DOM replacement) to avoid spurious snapshots.

### 7. Image Manager

`bindImageHandler(img)` paints a translucent white haze sized to the image's bounding box (re-measured on `mouseenter` so it stays correct as responsive layouts flow) plus a "Click to replace image" hint pill. Clicking opens a hidden file input.

`handleImageUpload(file, imgEl)`:
- Read as ArrayBuffer; snapshot for undo
- If `hasGitHub`: base64 + `github.uploadFile('assets/' + file.name)`. In offline mode the GitHub call is skipped entirely; status reads "Saving image..." → "Image saved ✓" instead of "Uploading..." / "Image uploaded ✓".
- If `dirHandle`: `writeImageToLocalDir(file)` writes the bytes into `assets/`.
- Always: `imgEl.src` is set to a fresh `URL.createObjectURL(...)` blob URL and `data-gitqi-src` is set to `'./assets/' + file.name`. The blob URL is used so replacing an image with a new file of the same name doesn't show the browser-cached old bytes; the serializer resolves `data-gitqi-src` back to the relative path on save and publish.

The favicon upload path in the Theme editor follows the same `hasGitHub` gating.

### 7a. Video Manager

YouTube embedding. No upload path — videos are external URLs. Users paste any common YouTube URL (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, or bare 11-char id) and `extractYouTubeId` normalises it to `/embed/ID`.

**Canonical markup** (what AI produces, what the editor binds to, what ships in published output) — a 16:9 responsive container (`padding-bottom:56.25%`) wrapping an `<iframe src="https://www.youtube.com/embed/{ID}">`. The wrapper `<div data-editable-video>` owns the click interaction because iframes swallow pointer events. The placeholder ID (`M7lc1UVf-VE`) is the YouTube Developers talk Google uses in the official IFrame Player API docs — guaranteed embeddable. The embed domain is `youtube.com` rather than `youtube-nocookie.com` because the latter shows an unfamiliar domain in the edit popover; in testing it didn't resolve YouTube's intermittent Error 153 anyway (which is usually environmental: ad/content blockers or network filtering).

**Flow:**
1. `activateZone` finds every `[data-editable-video]` wrapper and calls `bindVideoHandler(wrapper)` (idempotent via `data-gitqi-video-bound='1'`).
2. `bindVideoHandler` injects a transparent overlay (`data-editor-ui`, `inset:0`, `z-index:10`) over the iframe. Hover fades in a "Click to change video" pill. On `file://` it also shows a persistent "Preview only — video plays once published" pill, since YouTube blocks playback on `file://` origins with Error 153.
3. Overlay click → `openVideoPopover(wrapper, { x, y })`. The popover anchors at the click coordinates (via `positionPopoverAtPoint`) so it stays under the cursor regardless of how big the video is — anchoring to the wrapper itself would push the popover off-screen for fullscreen-width videos.
4. Apply parses the input via `extractYouTubeId`; valid URLs update `iframe.src` and mark dirty. Remove video calls `snapshotForUndo()` then deletes the wrapper.

**State markers:** `data-gitqi-video-bound='1'` (stripped by serializer + `captureSnapshot`); the overlay carries `data-editor-ui` (stripped the same way).

**AI prompts:** `buildSectionPrompt`, `buildReformatPrompt`, and `buildPagePrompt` all include the canonical wrapper as an explicit rule. `buildReformatPrompt` additionally instructs the model to preserve existing `[data-editable-video]` wrappers verbatim so reformatting doesn't corrupt the marker structure.

### 8. Selection Toolbar

Floating toolbar shown when there's a non-empty selection inside any `[data-editable]` element.

| Button | Action |
|---|---|
| **B** | `execCommand('bold')` → normalizes `<b>` → `<strong>` |
| *I* | `execCommand('italic')` → normalizes `<i>` → `<em>` |
| 🪣 | Color flyout — theme swatches + custom picker + "Remove color" (paint bucket SVG) |
| Aa | Font flyout — theme font vars + Google Fonts picker + "Clear font styling" |
| A↕ | Font-size flyout — em-based presets (Smaller 0.75 / Small 0.875 / **Normal** / Large 1.25 / Larger 1.5 / Huge 2). Relative `em` units so a bump inside a heading stays heading-scaled and a bump in body stays body-scaled. "Normal" strips the property instead of writing a redundant `font-size: 1em`. |
| `</>` | Wrap/unwrap selection in `<code>` |
| 🔗 | Wrap selection in `<a>` → open link popover |

**Sticky positioning** — once the toolbar is up, opening a flyout grows it downward. It does **not** re-pin to the selection (an earlier "smart" reposition yanked the row up and out from under the user's cursor mid-click). `clampSelectionToolbarInViewport()` only nudges the toolbar if growing it pushed it off-screen.

**Inline-style spans (color / font / font-size)** — every span the toolbar creates carries `data-gitqi-style`. `wrapSelectionInStyledSpan(prop, val)` calls `clearInlineStyleFromSelection(prop, { onlyIfFullyCovered: true })` first so repeated changes to the same property replace rather than nest. Scope is any inline-styled `<span>`, gitqi-owned or hand-authored — the **full-coverage guard** keeps it safe: a property is only stripped from a span if the selection covers ALL of that span's contents, so hand-authored markup that extends beyond the selection is never mutated. Explicit "Remove color" / "Clear font" / "Normal" drop the guard since the user is being explicit.

The `data-gitqi-style` marker is stripped in publish output (`serialize({local: false})`) but preserved in local saves and snapshots so it survives re-opens and undo/redo.

### 9. Link Editor

Intercepts clicks on `<a>` elements inside `[data-zone]` or `<nav>` in the capture phase and shows a popover.

**Popover fields:**
- **Display text** — updates `textContent` live
- **URL** — updates `href` live
- **Go to link →** — opens the URL in the same tab. Relabelled **Test email →** when the URL is `mailto:`.
- **Subject** + **Body** (mailto only) — collapsible block that appears whenever the URL starts with `mailto:`. `parseMailto(url)` reads existing `?subject=` / `?body=` into the inputs on open; editing either input rebuilds the URL via `buildMailto({address, subject, body})`. A `suppressUrlSync` flag breaks the URL→inputs→URL feedback loop.
- **Page/section picker** — dropdown grouped by page. Current page's zones from the DOM; other pages' zones loaded async from disk via `dirHandle`.
- **Open in new tab** — toggles `target="_blank"` + `rel="noopener noreferrer"`. Auto-checks for external `https?://` URLs unless the user has explicitly toggled it in the same session.
- **Remove link** — context-aware, always undoable (`snapshotForUndo()` before any mutation):
  - In a `<nav>`: drop the wrapping `<li>` (or the `<a>` itself for flat navs) and reset `lastSyncedSharedSnapshot` so the change propagates. If the removed link pointed at `CURRENT_FILENAME`, surface a warning status. This is the canonical way to remove a nav link — the native per-item hover controls deliberately don't include a ✕ to avoid misclick deletions.
  - Inside a `[contenteditable="true"]` host (i.e. inline body link in a `[data-editable]` zone): unwrap `<a>` to a text node so the surrounding sentence keeps flowing. Text remains selectable + re-linkable via the selection toolbar's 🔗 button.
  - Outside any editable host (typically a styled CTA button living in a structural wrapper that itself isn't editable): remove the whole `<a>` element. Leaving an un-editable, un-re-linkable text node behind would have been worse than no element at all.

**Positioning** (`positionPopover` and `reclampPopoverAfterResize`) — measures the actual rendered popover size (the old guess-then-flip approach mis-flipped tall popovers when the guess was wrong), prefers the side with more room, and re-clamps when the popover resizes (e.g. mailto fields appearing/disappearing) without yanking it to a new anchor.

### 10. Section Reformat

Gated on `hasGemini`. `activateZone` only injects the **⟳ Reformat** per-section button when Gemini is configured.

`promptReformatSection(section)` — modal → on submit → `snapshotForUndo()` → `reformatSection()`:

- `buildReformatPrompt()` sends: main style block, section-specific CSS, clean section HTML, plus rules to preserve content + existing `[data-editable-video]` wrappers verbatim
- `callGeminiWithFallback(prompt, { model })` (see §13a)
- `parseSectionResponse()` expects `<section-css>…</section-css>` followed by `<section-html>…</section-html>`
- Upsert `<style id="__gitqi-section-{slug}-styles">` and replace the section, then `activateZone(newSection)`

### 11. Nav Editor

`activateNav()` marks the nav with `data-gitqi-nav-bound` and always calls `injectNavControls(nav)`. When `hasGemini` it ALSO injects the **⟳ Reformat Nav** hover button (top-right corner of the nav). Without Gemini, native controls are the only way to edit the nav.

**Native nav controls (`injectNavControls`)** — always present regardless of AI availability:

- **(+) per cluster** — items within each `<ul>`/`<ol>` are clustered by a class signature that combines the wrapper's classes *and* the inner anchor's classes (the latter is where CTA styling almost always lives — e.g. `<li><a class="btn btn-primary">`). Each contiguous run of same-signature items is a cluster and gets its own hover-revealed (+) button placed right after the cluster. Click clones the cluster's last currently-present item, opens the link popover on the new anchor for label + URL editing. The same clustering applies to flat-anchor navs (bare `<a>` children of `<nav>` other than logo links).
- **← → reorder** — per-item hover-revealed arrows that swap with the previous/next non-editor-UI sibling. Arrows match horizontal-nav reading order; the underlying operation works for vertical navs too. No ✕ button on items — removal goes through the link popover (avoids destructive misclicks on a hover control).
- **Idempotent re-bind** — `injectNavControls` is called on every `activateNav` (including after Reformat Nav, add/duplicate page, restoreSnapshot). To stay idempotent, it strips all `[data-gitqi-nav-add]` placeholders and clears `[data-gitqi-nav-item-bound]` markers (along with the editor-UI control children inside those items) at the top of every run, then re-binds from scratch. Without this, placeholders accumulate after each rebind.
- **State markers**: `data-gitqi-nav-item-bound="1"` on real items, `data-gitqi-nav-add="1"` on (+) placeholders (also `data-editor-ui` so they're stripped on serialize). The serializer, `getNavHTML`, and `captureSnapshot` all strip `data-gitqi-nav-item-bound`.

`reformatNav(nav, description, { model })` — AI-driven, gated on `hasGemini`:
- `buildReformatNavPrompt()` sends: style block, nav-specific CSS, nav HTML
- `parseNavResponse()` expects `<nav-html>…</nav-html>` and optionally `<nav-css>…</nav-css>` (AI omits the CSS for content-only changes like adding/removing a link)
- Replace the nav, `rerunInlineScripts(newNav)` to rebind hamburger toggles, `activateNav()`, then force-sync (`lastSyncedSharedSnapshot = ''` → `syncSharedToOtherPagesIfChanged()`)

`addLinkToNav(navEl, label, href)` — programmatic link insertion (used by `generatePage` and `duplicatePage`). Picks the *largest* `<ul>`/`<ol>` by real-item count (ties tied → add to all, to support mobile/desktop duplicate-nav patterns); within that list, clusters items by style and clones from the largest cluster via `pickMainNavTemplate` so a new "main page" link doesn't inherit CTA-button styling. Inserts the new item before any trailing `data-editor-ui` placeholder so it lands at the end of the real items, not after the (+). The clone is scrubbed of inherited `data-gitqi-nav-item-bound` markers and editor-UI children via `prepareClonedNavItem` so the follow-up `activateNav` binds fresh controls (no missing ← → until reload).

Flat-anchor fallback (no `<ul>` in the nav): clones from the template's own cluster and inserts after the cluster's last anchor.

**Hamburger script pattern** — nav inline scripts should bind to the `<nav>` element (not `document` or `window`) so listeners are cleaned up when the nav is replaced and re-bound when `rerunInlineScripts` re-executes them:

```js
(function() {
  const nav = document.currentScript.closest('nav');
  nav.addEventListener('click', function(e) {
    if (e.target.closest('.hamburger-class')) toggleNav();
  });
})();
```

### 12. Pages Manager

Multi-page management. Requires folder access (`dirHandle`).

- `openPagesPanel()` — toggled by the Pages toolbar button. Lists all pages from `pagesInventory`, with **⧉ Duplicate** + **✨ Init** + **Open** + **✕ Delete** per page. Duplicate and Init are shown on the current row too; Open and Delete only on non-current rows. Init dispatches to the live or disk path based on which page was clicked (see §1a). The small circular row buttons share a `pageRowIconButton(label, title, hoverBg)` helper so each action gets a distinct accent while staying visually consistent.
- `promptAddPage` / `generatePage(description, navLabel, filename, { model })`: AI-only, gated on `hasGemini`. Snapshot, build prompt (style block, nav-specific CSS, nav HTML verbatim, example section), call AI, write to disk, register in inventory, `addLinkToNav` programmatically, `activateNav()`, force-sync. The **+ Add Page** button at the bottom of the panel only appears when `hasGemini`.
- `promptDuplicatePage(sourcePage)` / `duplicatePage(sourcePage, newFilename, navLabel)` — **no AI**, available regardless of Gemini. Modal collects new filename (default: `{stem}-copy`) and optional nav label; `sanitizeFilename` lowercases, replaces whitespace with hyphens, strips characters outside `[a-z0-9._-]`, and ensures a `.html` suffix; rejects collisions with `pagesInventory`. Reads source bytes (for the current page, `serialize({ local: true })` is used instead so any unsaved live edits are captured), rewrites `<title>` via `filenameToTitle`, writes to disk, registers in inventory, `addLinkToNav` to the current nav, force-sync.
- `deletePageFromSite(page)`: `removePageFromNav` strips nav links pointing to the file, remove from inventory, `dirHandle.removeEntry(filename)`, force-sync to clean nav across all pages.

### 13. AI Section Generator

Gated on `hasGemini`. `activateZones` only injects the **+ Add Section** buttons when Gemini is configured. There is no native equivalent — to seed a new section without AI, users duplicate an existing section and edit the copy.

`promptAddSection(insertAfterZone)` → modal → snapshot → `generateSection`:
- `buildSectionPrompt()` sends: style block + example zone HTML
- `callGeminiWithFallback`, `parseSectionResponse`, upsert `<style id="__gitqi-section-{slug}-styles">`, inject the new section, `activateZone()`

### 13a. Gemini Model Fallback

All four AI flows (Add Section, Reformat Section, Reformat Nav, Add Page) route through `callGeminiWithFallback(prompt, opts)` which retries on a different Gemini model when the primary is overloaded (503) or rate-limited (429). Real users hit `gemini-2.5-flash` overload for extended periods and had no recourse without refreshing or switching keys.

**Model chain** (ordered, first is default):

```
gemini-2.5-flash    // default
gemini-2.5-pro      // slower but often available when Flash is saturated
gemini-2.0-flash
gemini-flash-latest
gemini-2.5-flash-lite
```

Each AI Studio model has its own RPM/RPD quota, so falling back on 429 also works — different model, different bucket.

**Retryable statuses** (`RETRYABLE_GEMINI_STATUS`): 429, 500, 503, 504. 4xx auth / bad-request errors break the loop early.

**Session stickiness** — `sessionPreferredModel` is set when a fallback succeeds, so subsequent calls start from the working model instead of re-hitting the known-busy primary.

**UX:**
- If `opts.model` is set, only that model is used (no fallback) — for explicit user override from the error UI.
- `onFallback(model, priorError)` fires the first time we move past the primary so callers can show a status message.
- On total failure, the error has `.tried = [{ model, status, message }]` and a summary distinguishing all-busy (503) vs. all-quota (429).
- `makeAIErrorArea()` returns a shared error block (`{ el, getModel, render, renderSimple, reset }`) used by all four AI dialogs. `render(err)` shows the message plus a model `<select>` (Auto + each model id); `getModel()` is read on retry; `renderSimple(text)` is used for non-AI errors with the picker hidden.

### 14. Serializer / Exporter

`serialize({ local })` clones `document.documentElement` and produces clean HTML. Idempotent.

Both modes:
- Remove all `[data-editor-ui]` (toolbar, modals, hover buttons, hint pills)
- Remove `contenteditable` and `spellcheck`
- Remove `data-gitqi-bound`, `data-gitqi-nav-bound`, `data-gitqi-nav-item-bound`, `data-gitqi-video-bound`
- Resolve `img[data-gitqi-src]` (blob URL → stored relative path)
- Strip any inline `style` attribute on `<html>` (older versions wrote CSS vars there for live preview; would shadow `:root` updates)
- Restore the original `body { padding-top }` and any fixed-nav `top` offset that was shifted for the toolbar

`local: false` only:
- Strip `<script src="…secrets.js">` and `<script src="…gitqi.js">`
- Strip the `data-gitqi-style` marker from styled spans (the spans keep their inline styles)
- `obfuscateMailtoLinks(clone)` — see §14a

`exportToFile()` runs `serialize({ local: false })` and triggers a download.

### 14a. Email obfuscation (publish-output only)

`obfuscateMailtoLinks(root)` runs inside `serialize({ local: false })`, so it covers both Publish and Export — every artifact that leaves the editor has obfuscated mailto links. Live edits and `local: true` saves stay readable.

For each `<a href="mailto:…">`: the URL is encoded via `gqEncode` (base64 of reversed UTF-8) into `data-gqe`, and `href` becomes `javascript:void(0)`. Text-node occurrences of the address inside the link are replaced with `<span data-gqt="…">` placeholders (`obfuscateEmailInTextNodes`), preserving original casing so `Foo@Bar.com` round-trips. A single inline decoder script (`[data-gqe-decoder]`) is appended once per body and reverses the encoding at page load, also stripping `data-gqe`/`data-gqt` so the live DOM ends up clean.

**Trade-off:** no `<noscript>` fallback — emitting the email there would defeat the protection. **Cross-document safety:** also called on disk-parsed pages in `publishSite()`; helpers use `node.ownerDocument` so nodes land in the correct doc.

### 15. GitHub Publisher

Gated on `hasGitHub`. The Publish toolbar button is not rendered when `githubToken` or `repo` is missing — Export becomes the rightmost CTA in that mode and `publishSite()` cannot be invoked from the UI. `publishSite()` itself still has its `if (!githubToken || !repo)` guard as a defence-in-depth check.

`publishSite()`:

1. Current page: `serialize({ local: false })` → `github.putFile(CURRENT_FILENAME, html, sha)`
2. All other pages (if `dirHandle` + `pagesInventory`): read each page from disk → `DOMParser` → strip editor scripts → strip `data-gitqi-style` markers → `obfuscateMailtoLinks(doc)` → `github.putFile`
3. `gitqi-pages.json`: `github.putFile`

The disk-loaded pages were last saved with `local: true`, so they still have plain mailto links and `data-gitqi-style` markers — both have to be cleaned per-page on the publish path because they didn't go through `serialize({ local: false })`.

`github.getFileSHA(path)` → GET `/repos/{repo}/contents/{path}?ref={branch}` → return `.sha` (null on 404). `github.putFile(path, content, sha)` → PUT same endpoint, body `{ message, content: btoa(unescape(encodeURIComponent(content))), sha, branch }`. SHA conflicts (HTTP 409) on the current page are silently swallowed; other pages with errors are surfaced in the status message.

### 16. Undo / Redo

Snapshot-based, capped at `UNDO_LIMIT = 20`. Text edits use the browser's native undo inside `contenteditable`; structural changes call `snapshotForUndo()` first. Keyboard: Ctrl+Z → undo; Ctrl+Shift+Z / Ctrl+Y → redo. Skipped when `e.target.isContentEditable`.

**Snapshot triggers:**
- **Sections** — delete, duplicate, move ↑/↓, reformat, add, empty-editable remove (red ✕ pill).
- **Pages** — generate, duplicate, delete.
- **Nav** — reformat, native add link, native move ← →, link-popover Remove link (nav / editable-body / non-editable-body branches).
- **Images** — image upload. Old asset files aren't deleted on swap, so undo just restores the prior `src`.
- **Videos** — URL change in the YouTube popover; Remove video.
- **Inline text formatting** — code wrap/unwrap, link wrap, `wrapSelectionInStyledSpan` (color / font / size), explicit `clearInlineStyleFromSelection`. Bold/italic use the browser's native `execCommand` undo since those are pure text edits.
- **Link popover live edits** — one snapshot per popover session, taken lazily on the first mutation, so Ctrl+Z reverts the whole session rather than one keystroke.

`captureSnapshot()` clones `<body>` (stripping editor UI and binding markers) and stores all GitQi-managed `<style>` blocks. `restoreSnapshot()` disconnects the mutation observer, closes popovers, swaps in the snapshotted body while preserving live editor-UI nodes, restores styles, re-runs `activateZones() + activateNav() + rerunInlineScripts(nav)`, re-binds the observer, and resets `lastSyncedSharedSnapshot`.

### 17. Theme Editor

Toggled by the **Theme** toolbar button, mutually exclusive with the Pages panel.

- **Site Identity** — favicon (PNG-converted, uploaded + written locally + favicon links upserted), page title, meta description, keywords. Title/description/keywords are page-specific (not synced); favicon syncs.
- **CSS Variables** — grouped Colors / Typography / Spacing / Layout. Live preview via `documentElement.style.setProperty()` plus patching the main `<style>` textContent (which then propagates to every page on the next sync).
- Color vars get a color picker + hex input. Font-family vars get a text input plus the **Aa** Google Fonts picker (`makeGoogleFontPicker`). The Typography group has an inline "Add font variable" form whose font picker fills the value only — the var name describes the role (e.g. `--font-display`), not the family — and the `<link>` is injected on Add, not on preview.

Maintenance actions (asset cleanup, folder re-link, page init) live in the **⚙ Site Utilities** panel, not here.

### 17a. Asset Cleanup

Find files under `assets/` that nothing references, with a preview-and-confirm flow before any deletion.

`collectAssetReferences()` uses two strategies per source: a DOM walk over URL-bearing attributes and `<style>` blocks (`harvestAssetRefsFromDoc`) plus a text regex (`ASSET_REF_RE = /assets\/([^\s"'\`)<>?#,]+)/gi`) for CSS `url()`, inline scripts, JSON, etc. Paths go through `normalizeAssetPath` (strips query/fragment, URL-decodes so `My%20Photo.jpg` matches `My Photo.jpg`, normalizes `./` prefix). Sources: live `document`, `serialize({ local: true })` of the current page, every other inventory page parsed via `DOMParser`, and `gitqi-pages.json`. The scanner errs heavily toward false-positives — false-negatives break the live site, false-positives just add a checkbox to the review modal.

`enumerateLocalAssets()` recursively walks `dirHandle.getDirectoryHandle('assets')` → `Map<path, FileSystemFileHandle>`. `enumerateRemoteAssets()` walks `github.listDirectory('assets')` → `Map<path, sha>` (empty when `!hasGitHub`).

`promptAssetCleanup()` computes orphans = union(local, remote) minus refs, then renders a modal with per-file checkboxes (default checked), size, thumbnail for images, and a local/github source badge. Confirm runs `runAssetCleanup(selected)` which deletes via `dirHandle.removeEntry` (recursive) and `github.deleteFile` (DELETE requires the sha we already have). Per-file failures don't abandon the rest. The `github.deleteFile(path, sha)` and `github.listDirectory(path)` helpers treat 404 as a no-op, so cleanup is idempotent across partial failures.

### 18. Google Fonts

Full Google Fonts catalog, sorted by popularity. A small curated list is compiled into `gitqi.js` as a fallback; at runtime `loadGoogleFontsManifest()` fetches the complete catalog from `google-fonts.json` (sibling of `gitqi.js`, generated via `make fonts`) and replaces the in-memory `GOOGLE_FONTS`. Entries: `{ name, cat, weights }`; array order is popularity rank.

Fast path reads a cached manifest from `localStorage` (`gitqi:fonts-manifest:v1`) and installs it synchronously; background fetch refreshes the cache. Failures are silent — the curated fallback remains.

`ensureGoogleFontLink(font)` upserts the two preconnect links and appends a `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family={name}:wght@{weights}&display=swap">`. Idempotent — skips insertion if the family is already present.

**Font previewer** (`openFontPreviewer(onPick)`) — modal with sample-text input (persisted in `localStorage`), category pills, name search, and popularity / A–Z sort. Rows render immediately with a "…" placeholder; an `IntersectionObserver` (rootMargin 240px, 500ms debounce) collects visible fonts and feeds them into a rate-limited loader that registers FontFaces directly into `document.fonts` (no DOM `<style>` or `<link>` injection during preview). Loader runs `PREVIEW_LOAD_BATCH` (4) at `PREVIEW_LOAD_INTERVAL_MS` (250ms) ≈ 16 fonts/sec. The previewer never injects `<link>` tags itself — only the row click does (via `onPick` → caller → `ensureGoogleFontLink`), so cancelled previews don't leak.

`prewarmFontPreview()` (called by `openThemeEditor`) enqueues every family in popularity order so the picker opens with most popular families already rendered.

`pruneUnusedGoogleFontLinks()` runs at the top of every `saveChanges()`. It scans the main `<style>`, nav style, and per-section styles for `font-family:` and `--font-*` declarations; any `<link href*="fonts.googleapis.com/css">` whose family isn't referenced is removed (preconnects too when the last stylesheet goes). The shared-head sync then propagates the cleanup to every other page.

### 19. DOM Helpers

`rerunInlineScripts(el)` — replaces every inline `<script>` with a fresh element to force execution. Scripts parsed via `innerHTML`/`replaceWith` are inert; the browser does not run them. Used after nav replacement (`reformatNav`, `restoreSnapshot`) to rebind hamburger listeners.

---

## CSS Variable System

The base `<style>` block in each page must define CSS custom properties so AI-generated sections and pages can use them consistently.

**Required variables (minimum set):**

```css
:root {
  --color-primary:    #...;
  --color-secondary:  #...;
  --color-accent:     #...;
  --color-bg:         #...;
  --color-bg-alt:     #...;
  --color-text:       #...;
  --color-text-muted: #...;

  --font-heading: 'Font Name', sans-serif;
  --font-body:    'Font Name', sans-serif;
  --font-size-base: 1rem;
  --line-height-base: 1.6;

  --space-xs:  0.25rem;
  --space-sm:  0.5rem;
  --space-md:  1rem;
  --space-lg:  2rem;
  --space-xl:  4rem;

  --container-width: 1100px;
  --radius:          0.375rem;
  --shadow:          0 2px 12px rgba(0,0,0,0.08);
}
```

**GitQi-managed style blocks:**
- `<style id="__gitqi-nav-styles">` — nav-specific CSS written by Reformat Nav
- `<style id="__gitqi-section-{slug}-styles">` — per-section CSS written by section Reformat / Add Section. Duplicate clones the block under the new slug with regex slug rewrites.

---

## Secrets & Security Notes

- `secrets.js` lives only on the local machine — the site folder is not a git repo and `secrets.js` is never committed or transmitted anywhere except directly to the GitHub and Google APIs
- The GitHub PAT should be a **fine-grained token** scoped to the single site repo with `contents: read+write` only
- The Gemini API key is used **client-side** — acceptable for personal/single-owner use; for shared or public use, proxy through a serverless function
- The exported/published HTML contains **no credentials** and **no editor code**
- `mailto:` links are obfuscated in published output (see §14a). Plain emails authored as ordinary text outside `<a href="mailto:…">` are not protected — that's the user's call.

---

## Browser Compatibility

GitQi requires the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API).

| Browser | Edit mode | Public site |
|---|---|---|
| Chrome 86+ | ✓ | ✓ |
| Edge 86+ | ✓ | ✓ |
| Safari | ✗ | ✓ |
| Firefox | ✗ | ✓ |

Opening a page in an unsupported browser shows a blocking modal and prevents the editor from loading entirely. The published site is plain HTML and works everywhere.

---

## Non-Goals (explicitly out of scope)

- Multi-user editing or auth
- Version history UI (git history serves this purpose)
- Any server-side component
