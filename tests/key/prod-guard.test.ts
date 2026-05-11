/**
 * tests/key/prod-guard.test.ts
 *
 * F6: Fail-fast guard for all-zero APP_ENCRYPTION_KEY in production.
 *
 * Tests:
 *   - production mode + all-zero key → throws
 *   - dev mode + all-zero key → passes (returns key bytes)
 *   - production mode + non-zero key → passes
 */

import { describe, it, expect, afterEach } from "vitest";

// All-zero 32-byte key (the dev placeholder)
const ALL_ZERO_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
// Non-zero 32-byte key (generated: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
const REAL_KEY = "Sz2tC/4E79939/YyvKjCOKUCKGLw0yqr8MN1J48Eucc=";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_KEY = process.env.APP_ENCRYPTION_KEY;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.APP_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("F6 — all-zero APP_ENCRYPTION_KEY guard", () => {
  it("throws in production when key is all-zero", async () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ENCRYPTION_KEY = ALL_ZERO_KEY;

    // Re-import with fresh module state by calling encrypt — which calls getKey()
    const { encrypt } = await import("../../db/encryption");

    expect(() => encrypt("test", "aad")).toThrow(
      "APP_ENCRYPTION_KEY is the all-zero placeholder; refusing to start in production."
    );
  });

  it("does NOT throw in development when key is all-zero", async () => {
    process.env.NODE_ENV = "development";
    process.env.APP_ENCRYPTION_KEY = ALL_ZERO_KEY;

    const { encrypt } = await import("../../db/encryption");

    expect(() => encrypt("test", "aad")).not.toThrow();
  });

  it("does NOT throw in test mode when key is all-zero", async () => {
    process.env.NODE_ENV = "test";
    process.env.APP_ENCRYPTION_KEY = ALL_ZERO_KEY;

    const { encrypt } = await import("../../db/encryption");

    expect(() => encrypt("test", "aad")).not.toThrow();
  });

  it("does NOT throw in production when key is non-zero", async () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ENCRYPTION_KEY = REAL_KEY;

    const { encrypt } = await import("../../db/encryption");

    expect(() => encrypt("test", "aad")).not.toThrow();
  });
});
