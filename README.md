# Webby

A zero-dependency, browser-based inline editing system for static websites.

The site owner opens `index.html` locally, edits content in-place, and publishes directly to GitHub Pages — no terminal, no CMS, no backend required.

---

## How it works

Webby has two modes:

- **Edit mode** — activated automatically when `secrets.js` is present alongside `index.html`. The editor toolbar, editable zones, and AI tools all activate.
- **Public mode** — the deployed site. No editor code, no credentials, no overhead. `webby.js` and `secrets.js` are stripped from the published output.

The content "database" is the HTML file itself. The site owner edits text by clicking and typing directly on the page, replaces images by clicking them, and uses the AI assistant to generate new sections — all without touching code.

---

## Quick start (for site owners)

### 1. Generate your initial `index.html`

Use the [Bootstrap Prompt](./BOOTSTRAP_PROMPT.md) with Claude.ai (attach 2–5 inspiration images and fill in the bracketed fields). The output is a complete `index.html` ready to use.

### 2. Create a GitHub repository and enable GitHub Pages

1. Create a new **public** repository on GitHub (e.g. `jane/jane-osteopathy`)
2. Go to **Settings → Pages**
3. Under *Source*, select **Deploy from a branch**
4. Set branch to `main`, folder to `/ (root)`, and click **Save**
5. Add the GitHub Actions deploy workflow below (`.github/workflows/deploy.yml`) — this is what runs automatically every time Webby publishes your site

### 3. Add `secrets.js` to your local site folder

```js
window.SITE_SECRETS = {
  anthropicKey: "sk-ant-...",    // Anthropic API key (for AI section generation)
  githubToken:  "ghp_...",       // GitHub fine-grained PAT (contents: read + write)
  repo:         "jane/jane-osteopathy",
  branch:       "main"
};
```

> **This file stays on your computer only.** Webby publishes your site by pushing `index.html` directly to GitHub via the API — your local folder is never a git repository, and `secrets.js` is never sent anywhere except directly to the GitHub and Anthropic APIs.

### 4. Open `index.html` in your browser

The editor activates automatically. You'll see a dark toolbar at the top of the page.

### 5. Edit your content

- **Text** — click any text and type directly on the page
- **Images** — click any image to open a file picker; the new image uploads to GitHub automatically
- **New sections** — hover between sections and click **+ Add Section**; describe what you want and the AI generates it
- **Theme** — click **Theme** to adjust colours, fonts, and spacing live

### 6. Publish

Click **Publish** in the toolbar. Webby uses the GitHub API to push `index.html` directly to your repository — no git, no terminal, no syncing. GitHub Actions picks up the push and deploys to GitHub Pages within ~60 seconds.

> **How it works under the hood:** Webby serialises the current page (stripping all editor UI and credentials), then calls the GitHub Contents API to write the file. Only `index.html` is updated; everything else in your repo (images, workflow files, etc.) is untouched unless you explicitly replaced an image during editing.

---

## HTML data attributes

Webby uses data attributes to identify editable regions. These must be present in the generated HTML.

| Attribute | Applied to | Purpose |
|---|---|---|
| `data-zone` | `<section>` | Marks a top-level editable section. Value is a slug, e.g. `"hero"`. |
| `data-zone-label` | `<section>` | Human-readable label shown in the delete confirmation, e.g. `"Hero"`. |
| `data-editable` | Any text element | Makes the element directly editable via `contenteditable`. |
| `data-editable-image` | `<img>` | Makes the image replaceable by clicking. |

**Minimal example:**

```html
<section data-zone="about" data-zone-label="About">
  <h2 data-editable>About Me</h2>
  <p data-editable>Replace this with your own text.</p>
  <img src="./assets/placeholder.jpg" data-editable-image alt="Profile photo" />
</section>
```

---

## Script tags

Two script tags must appear in `<head>` (after the `<style>` block) for edit mode to work locally. They are stripped automatically on export/publish — the deployed site contains neither.

```html
<script src="./secrets.js"></script>
<script src="https://YOUR_GITHUB_PAGES_URL/webby.js"></script>
```

Replace `YOUR_GITHUB_PAGES_URL` with the URL where you host `webby.js` (see [Hosting webby.js](#hosting-webbyjs) below).

---

## GitHub Actions deploy workflow

Add this file to your site repo to enable automatic deployment:

`.github/workflows/deploy.yml`

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - uses: actions/deploy-pages@v4
```

---

## Hosting webby.js

`webby.js` is served from its own GitHub Pages repo (this one) so that multiple sites can share a single hosted copy.

**Latest version** (always up to date):
```
https://<your-username>.github.io/<this-repo>/webby.js
```

**Pinned version** (recommended for production — immune to breaking changes):
```
https://<your-username>.github.io/<this-repo>/webby-1.0.0.js
```

Pinned versioned files (e.g. `webby-1.0.0.js`) are committed alongside `webby.js` on each release and are never modified after publishing.

> **One-time setup required:** Go to **Settings → Pages → Source → Deploy from a branch**, set branch to `main`, folder to `/ (root)`, and save. After that, `make release` keeps the live files up to date automatically — no further configuration needed.

---

## Versioning

The current version is `v1.0.0`.

Versions follow [Semantic Versioning](https://semver.org/):

- **Patch** (1.0.x) — bug fixes, safe to update
- **Minor** (1.x.0) — new features, backwards compatible
- **Major** (x.0.0) — breaking changes; pinned sites are unaffected

The version is accessible at runtime:

```js
console.log(window.Webby.version); // "1.0.0"
```

---

## Development

```bash
# Local development server (http://localhost:8080)
make serve

# Check JavaScript syntax
make check

# Release a new version and publish to GitHub Pages
make release VERSION=1.1.0
```

See the [Makefile](./Makefile) for full details on what `make release` does.

---

## Security notes

- `secrets.js` lives only on your computer and is never published — your local folder is not a git repository
- The GitHub PAT should be a **fine-grained token** scoped to the single site repo with `contents: read + write` only
- The Anthropic key is used client-side — acceptable for personal/single-owner use; for shared use, proxy through a serverless function
- The exported and published HTML contains **no credentials** and **no editor code**
