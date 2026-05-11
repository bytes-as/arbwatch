import { defineConfig } from "@playwright/test";

process.env.ENABLE_TEST_ROUTES = "true";

export default defineConfig({
  // Only run Playwright spec files (not Vitest .test.ts files)
  testMatch: ["tests/**/*.spec.ts"],
  // Each test in the preview-sh contract can take up to 60s
  timeout: 60_000,
  // Do not retry — flakiness here means implementation is broken
  retries: 0,
  // Run spec files sequentially (they share port 3000)
  workers: 1,
  reporter: [
    ["list"],
    ["./tests/watched/seed-reporter.ts"],
  ],
  use: {
    // The preview.sh contract test drives fetch directly, not a browser page;
    // but Playwright is used for its process-management and assertion APIs.
    baseURL: "http://localhost:3000",
  },
});
