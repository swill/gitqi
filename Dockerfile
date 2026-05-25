# GitQi test runner — Playwright + Chromium in a container.
#
# We use Microsoft's official Playwright image because it ships a known-good
# Chromium with all the system libs pre-installed. Playwright itself is
# installed globally INSIDE the image so the host repo stays free of
# package.json / node_modules — the only host requirement is Docker.
#
# Bump PLAYWRIGHT_VERSION to upgrade; the image tag and the npm install must
# stay in lockstep (Playwright's browser bundles are pinned per-version).

ARG PLAYWRIGHT_VERSION=1.49.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG PLAYWRIGHT_VERSION
RUN npm install -g \
      playwright@${PLAYWRIGHT_VERSION} \
      @playwright/test@${PLAYWRIGHT_VERSION}

# Node only searches local node_modules + the prefix tree; without NODE_PATH
# pointing at the global install, `require('@playwright/test')` from a
# project that has no package.json fails with MODULE_NOT_FOUND. Resolving
# the actual prefix path at build time keeps this robust across Node images.
RUN echo "NODE_PATH=$(npm root -g)" >> /etc/environment
ENV NODE_PATH=/usr/lib/node_modules

# Python3 is already present in the base image and is used by Playwright's
# webServer config to serve the repo root at http://localhost:8080.

WORKDIR /work

# Default: run the test suite. Override with `docker run ... <cmd>` for
# headed/debug/shell invocations (see Makefile).
CMD ["playwright", "test", "--config=tests/playwright.config.cjs"]
