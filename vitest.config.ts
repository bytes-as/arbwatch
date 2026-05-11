import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests under tests/ that are NOT Playwright specs
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.spec.ts", "node_modules/**"],
    // Give each test file a clean environment
    environment: "node",
    // Reasonable timeout: the seed test has to do DB I/O
    testTimeout: 30_000,
    // Sequential inside each file; parallelism across files is fine
    sequence: {
      concurrent: false,
    },
    env: {
      NODE_ENV: "test",
      APP_ENCRYPTION_KEY:
        process.env.APP_ENCRYPTION_KEY ??
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      WIRE_MODE: "fixtures",
      DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
    },
  },
});
