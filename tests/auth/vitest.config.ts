/**
 * Vitest config scoped to tests/auth/ — server-level auth tests.
 *
 * This config is intentionally minimal. The skeleton dispatch
 * (task-skeleton-test / task-skeleton-impl) will provide the root-level
 * vitest.config.ts and package.json. This file exists so the auth tests
 * can be run in isolation before the root config lands:
 *
 *   npx vitest run --config tests/auth/vitest.config.ts
 *
 * Once the skeleton config lands, these tests will be picked up by the
 * root workspace config automatically (the root config should glob
 * "tests/**\/*.test.ts").
 *
 * Environment assumptions:
 * - NODE_ENV=test
 * - TEST_BASE_URL=http://localhost:3000 (or overridden via env)
 * - NEXTAUTH_URL=http://localhost:3000
 * - NEXTAUTH_SECRET=test-secret-do-not-use-in-prod
 * - DATABASE_URL=file:./.test.db (seeded SQLite)
 * - RESEND_API_KEY=re_test_placeholder (mock intercepts before real calls)
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "auth-unit",
    environment: "node",
    // Run each test file in its own isolated context so mock state
    // (the Resend inbox) does not leak between files.
    isolate: true,
    // Tests that reach a live server may be slow on cold start
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/auth/**/*.test.ts"],
    exclude: [
      "tests/auth/**/*.spec.ts", // spec = Playwright; only run .test.ts here
    ],
    env: {
      NODE_ENV: "test",
      TEST_BASE_URL: process.env.TEST_BASE_URL ?? "http://localhost:3000",
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? "http://localhost:3000",
      NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ?? "test-secret-do-not-use-in-prod",
      AUTH_SECRET:
        process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod",
      DATABASE_URL: process.env.DATABASE_URL ?? "file:./local.db",
      APP_ENCRYPTION_KEY:
        process.env.APP_ENCRYPTION_KEY ??
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      RESEND_API_KEY: "re_test_placeholder",
      SKIP_CSRF_CHECK: "true",
    },
    // Make vi, expect, etc. available as globals (needed by __mocks__/resend.ts
    // which uses vi.fn() without importing vi from vitest).
    globals: true,
    // In-process fetch interception: routes localhost:3000 requests to
    // route handlers in-process so vi.mock("resend") applies.
    setupFiles: ["./tests/auth/server-setup.ts"],
    // clearMocks resets call counts but keeps implementations intact.
    // mockReset would remove the vi.fn() implementation from __mocks__/resend.ts
    // which would break the inbox population. Only use clearMocks.
    clearMocks: false,
    mockReset: false,
    pool: "threads",
    // Process next-auth and next through Vite so aliases apply
    deps: {
      inline: [
        "next-auth",
        "@auth/core",
        "@auth/drizzle-adapter",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
      // next-auth imports "next/server" without .js extension; alias it
      "next/server": path.resolve(
        process.cwd(),
        "node_modules/next/server.js"
      ),
    },
    // Allow non-extension imports (ESM compat)
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
});
