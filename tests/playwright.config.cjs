// Playwright config for GitQi.
//
// GitQi requires the File System Access API, which is Chromium-only — so
// we don't bother with the firefox/webkit projects. The fake-fs init
// script handles the FSAPI surface; nothing here needs to grant browser
// permissions.
//
// webServer: a plain python http.server serving the REPO ROOT at :8080.
// Fixture pages live under /tests/fixtures/site/ and load gitqi.js via
// the absolute path /gitqi.js, exactly as a deployed site would.

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

module.exports = defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  outputDir: path.join(__dirname, 'test-results'),

  // One worker for the first iteration — keeps log output readable and
  // sidesteps any cross-test state leakage in the fake FS until we've
  // proven the harness solid. Bump later if suite gets slow.
  workers: 1,
  fullyParallel: false,

  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(__dirname, 'playwright-report'), open: 'never' }],
  ],

  use: {
    baseURL: 'http://127.0.0.1:8080',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // Headless by default; --headed flag from the CLI overrides.
    headless: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // SimpleHTTPRequestHandler doesn't add CORS headers, but every fetch
    // GitQi makes during a test goes through window.fetch (which the
    // api-mocks helper intercepts), so we don't need CORS here.
    command: 'python3 -m http.server 8080 --bind 127.0.0.1',
    cwd: REPO_ROOT,
    url: 'http://127.0.0.1:8080/gitqi.js',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
