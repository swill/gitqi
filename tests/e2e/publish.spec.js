// Publish flow — exercises the GitHub mock end-to-end.
//
// Sets up GitHub credentials, edits a heading, clicks Publish, then
// asserts the file landed in the mock repo with the new content (and
// with the editor script tags stripped, since publish uses
// serialize({ local: false })).

const { test, expect } = require('@playwright/test');
const {
  setupEditor,
  configureGitHub,
  getGitHubRepo,
  getGitHubCalls,
  readGitHubFile,
  waitForGitHub,
} = require('../helpers/setup');

const FIXTURE = '/tests/fixtures/site/index.html';

test('Publish writes the current page to GitHub with editor scripts stripped', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    github: {
      // Pre-seed an existing index.html — exercises the getFileSHA → PUT
      // (with sha) update path, not the create-from-scratch path.
      initialFiles: {
        'index.html': '<!DOCTYPE html><html><body>old</body></html>',
      },
    },
  });

  // Make a content change so the published HTML is observably different.
  const heading = page.locator('[data-zone="hero"] h1[data-editable]');
  await heading.click({ clickCount: 3 });
  await page.keyboard.type('Published Headline');

  // Click Publish. The button is in the toolbar (no ID, identified by text).
  await page.getByRole('button', { name: 'Publish' }).click();

  // Wait for the mock repo to reflect the new content.
  await waitForGitHub(
    page,
    (repo) => {
      const html = repo.read('index.html');
      return html != null && html.includes('Published Headline');
    },
    { timeout: 10_000 }
  );

  const published = await readGitHubFile(page, 'index.html');
  expect(published).toContain('Published Headline');
  expect(published).not.toContain('Welcome to the Test Site');

  // Editor scripts MUST NOT appear in published output. serialize({local:false})
  // strips both the gitqi.js and secrets.js script tags.
  expect(published).not.toContain('gitqi.js');
  expect(published).not.toContain('secrets.js');

  // Pages inventory is published alongside the HTML so the editor can
  // re-discover the multi-page site after a fresh clone.
  const repo = await getGitHubRepo(page);
  expect(Object.keys(repo).sort()).toEqual(['gitqi-pages.json', 'index.html']);

  // PUT request shape: should have called getFileSHA (GET) then putFile (PUT)
  // for the existing index.html.
  const calls = await getGitHubCalls(page);
  const indexCalls = calls.filter((c) => c.path === 'index.html');
  expect(indexCalls.map((c) => c.method)).toEqual(['GET', 'PUT']);
  expect(indexCalls[1].responseStatus).toBe(200);
});

test('Publish creates new files when they do not exist on GitHub yet', async ({ page }) => {
  await setupEditor(page, FIXTURE, {
    secrets: {
      githubToken: 'fake-token',
      repo: 'testuser/testrepo',
      branch: 'main',
    },
    // No initialFiles — empty repo. GitQi should hit 404 on getFileSHA
    // and then PUT without a sha (create path).
    github: {},
  });

  await page.getByRole('button', { name: 'Publish' }).click();

  await waitForGitHub(
    page,
    (repo) => repo.has('index.html') && repo.has('gitqi-pages.json'),
    { timeout: 10_000 }
  );

  const calls = await getGitHubCalls(page);
  const indexGets = calls.filter((c) => c.path === 'index.html' && c.method === 'GET');
  expect(indexGets[0].responseStatus).toBe(404); // file not present yet

  const indexPuts = calls.filter((c) => c.path === 'index.html' && c.method === 'PUT');
  expect(indexPuts[0].responseStatus).toBe(200); // create succeeded
});
