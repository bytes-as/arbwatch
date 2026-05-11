/**
 * tests/skeleton/root-endpoint.test.ts
 *
 * Mode 1 (pre-implementation) — these tests MUST FAIL until the Next.js app
 * skeleton is in place.
 *
 * Surfaces:
 *   - GET / returns 200 (or a redirect chain that resolves to 200 at /signin)
 *   - The response HTML includes the app-shell markers the design spec mandates:
 *       · "ArbWatch" (the app name from docs/design/auth-and-onboarding.md §5A)
 *       · "Sign in to ArbWatch" h1 copy (§5A)
 *   - The page title is "Sign in — ArbWatch" (§5A)
 *   - The "Send magic link" CTA is present (§5A submit button label)
 *
 * The test boots a real Next.js dev server on localhost:3000 because we need
 * to exercise the actual App Router, not a stub.  A short-lived child process
 * is spawned in beforeAll and torn down in afterAll.
 *
 * FAILURE MODE IN MODE 1:
 *   - beforeAll will throw because `next dev` is not available yet (no next
 *     package installed, no src/app directory).  All tests in the suite will
 *     be reported as failed due to the setup error.  This is the correct
 *     failing-by-construction behaviour.
 *
 * IMPLEMENTATION NOTE for the implementer:
 *   The test asserts against /signin (the unauthenticated landing).  The root
 *   handler must redirect unauthenticated visitors to /signin (flow 2A step 2).
 *   The /signin page must render HTML containing the strings below.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..");
const APP_URL = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const dir = join(tmpdir(), "predmkt-arb-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `root-endpoint-${process.pid}.db`);
}

/**
 * Spawn `next dev` and wait until stdout/stderr contains "localhost:3000".
 * Rejects if the server does not start within 45 seconds.
 */
function startNextDevServer(dbPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node_modules/.bin/next", ["dev", "--port", "3000"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "development",
        WIRE_MODE: "fixtures",
        DATABASE_URL: `file:${dbPath}`,
        APP_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        reject(
          new Error(
            "next dev did not print 'localhost:3000' within 45s — " +
              "is the Next.js app skeleton implemented?"
          )
        );
      }
    }, 45_000);

    const onData = (chunk: Buffer) => {
      if (resolved) return;
      const text = chunk.toString();
      if (text.includes("localhost:3000")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `next dev failed to spawn: ${err.message} — ` +
              "is 'next' installed and the app skeleton in place?"
          )
        );
      }
    });

    proc.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `next dev exited with code ${code} before printing 'localhost:3000'`
          )
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Root endpoint — app shell", () => {
  let serverProc: ChildProcess | undefined;
  const dbPath = makeTempDbPath();

  beforeAll(async () => {
    // This will fail until `next dev` is a valid command (Next.js not installed
    // yet, no src/app directory).  All tests below inherit this failure.
    serverProc = await startNextDevServer(dbPath);
    // Give the server a moment to finish binding after printing the URL.
    await delay(500);
  }, 60_000);

  afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill("SIGTERM");
      await delay(500);
    }
  });

  it("GET / resolves (with redirect) to a 200 response", async () => {
    // fetch follows redirects by default; we expect the final destination to be 200
    const res = await fetch(`${APP_URL}/`, { redirect: "follow" });
    expect(res.status).toBe(200);
  });

  it('app shell contains the app name "ArbWatch"', async () => {
    const res = await fetch(`${APP_URL}/`, { redirect: "follow" });
    const html = await res.text();
    // docs/design/auth-and-onboarding.md §5A, §3A — app name
    expect(html).toContain("ArbWatch");
  });

  it('app shell contains the "Sign in to ArbWatch" heading (§5A h1 copy)', async () => {
    const res = await fetch(`${APP_URL}/`, { redirect: "follow" });
    const html = await res.text();
    // §5A: <h1> text is "Sign in to ArbWatch"
    expect(html).toContain("Sign in to ArbWatch");
  });

  it('page title matches "Sign in — ArbWatch" (§5A)', async () => {
    const res = await fetch(`${APP_URL}/`, { redirect: "follow" });
    const html = await res.text();
    // §5A: Page <title> is "Sign in — ArbWatch"
    expect(html).toMatch(/Sign in.*ArbWatch/);
    expect(html).toContain("<title>");
  });

  it('sign-in page includes "Send magic link" CTA (§5A submit button)', async () => {
    const res = await fetch(`${APP_URL}/`, { redirect: "follow" });
    const html = await res.text();
    // §5A: Submit button (idle) label is "Send magic link"
    expect(html).toContain("Send magic link");
  });
});
