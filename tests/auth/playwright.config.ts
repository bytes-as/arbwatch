/**
 * Playwright config scoped to tests/auth/ — browser-level auth tests.
 *
 * Run with:
 *   npx playwright test --config tests/auth/playwright.config.ts
 *
 * The skeleton dispatch will provide a root playwright.config.ts.
 * This scoped config exists so browser auth tests can be developed and
 * run in isolation. The root config should import or extend this.
 *
 * Environment assumptions (same as vitest.config.ts):
 * - TEST_BASE_URL=http://localhost:3000 (Next.js dev or preview.sh server)
 * - FIXTURE_SESSION_TOKEN: seeded into the SQLite DB by the skeleton seed,
 *   referenced by redirect-when-authenticated.spec.ts.
 */

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./",
  // Only pick up Playwright .spec.ts files (not Vitest .test.ts)
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Auth tests modify shared session/cookie state; run serially.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // Capture traces on failure for debugging cookie/redirect issues
    trace: "on-first-retry",
    // Capture screenshots on failure
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // The Next.js dev server must be started separately before running
  // these tests (preview.sh or `next dev`). We do not auto-start it here
  // to keep the config simple before the skeleton lands.
  //
  // Once the skeleton's root playwright.config.ts exists, it can
  // configure `webServer` to auto-start preview.sh. For now:
  // $ ./preview.sh &
  // $ npx playwright test --config tests/auth/playwright.config.ts
});
