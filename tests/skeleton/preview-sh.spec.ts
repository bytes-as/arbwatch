/**
 * tests/skeleton/preview-sh.spec.ts
 *
 * Mode 1 (pre-implementation) — these tests MUST FAIL until preview.sh is
 * fully implemented.
 *
 * Surfaces:
 *   (b) preview.sh starts the service and prints "http://localhost:3000"
 *       within 30 s.
 *   (b) GET http://localhost:3000/ returns 200 and contains the app-shell
 *       marker ("ArbWatch").
 *   (d) preview.sh is idempotent: a second invocation against an already-seeded
 *       DB completes cleanly (exit 0) and does not duplicate seed rows.
 *
 * Uses Playwright's test runner for its process-management, assertions, and
 * timeout handling.  No browser is launched — we use the Node fetch API to
 * probe the HTTP endpoint.
 *
 * IMPLEMENTATION NOTE for the implementer:
 *   preview.sh must:
 *   1. Apply the Drizzle schema (drizzle-kit push or equivalent).
 *   2. Run scripts/seed.ts (which must be idempotent via ON CONFLICT DO NOTHING).
 *   3. Start `next dev` on port 3000.
 *   4. Print a line containing the literal string "http://localhost:3000".
 *
 *   The idempotency test kills the server after the first run, re-runs preview.sh
 *   against the same DB file, and asserts the watched_questions count is still 3
 *   (not 6) after the second run.  The seed script must use upsert semantics
 *   (INSERT OR IGNORE / ON CONFLICT(id) DO NOTHING) to achieve this.
 */

import { test, expect } from "@playwright/test";
import {
  ChildProcess,
  spawn,
  execFileSync,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..");
const PREVIEW_SH = join(REPO_ROOT, "preview.sh");
const STARTUP_TIMEOUT_MS = 30_000; // DoD says 30s
const APP_URL = "http://localhost:3000";
const TEST_APP_ENCRYPTION_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(label: string): string {
  const dir = join(tmpdir(), "predmkt-arb-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `preview-sh-${label}-${process.pid}.db`);
}

/**
 * Spawn preview.sh and wait for it to emit a line containing
 * "http://localhost:3000".
 *
 * Returns the child process (still running — the caller must kill it).
 * Rejects if the string is not emitted within STARTUP_TIMEOUT_MS.
 */
function spawnPreviewSh(dbPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WIRE_MODE: "fixtures",
      DATABASE_URL: `file:${dbPath}`,
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "development",
    };

    const opts: SpawnOptionsWithoutStdio = {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    };

    const child = spawn("bash", [PREVIEW_SH], opts);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        reject(
          new Error(
            `preview.sh did not print "http://localhost:3000" within ${
              STARTUP_TIMEOUT_MS / 1000
            }s`
          )
        );
      }
    }, STARTUP_TIMEOUT_MS);

    const checkOutput = (chunk: Buffer) => {
      if (resolved) return;
      const text = chunk.toString();
      // DoD: "Waits up to 30s for the service to print a line containing the
      // literal string http://localhost:3000"
      if (text.includes("http://localhost:3000")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout?.on("data", checkOutput);
    child.stderr?.on("data", checkOutput);

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(`preview.sh spawn error: ${err.message}`)
        );
      }
    });

    child.on("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `preview.sh exited prematurely with code=${code} signal=${signal} ` +
              `before printing "http://localhost:3000"`
          )
        );
      }
    });
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (!child.killed) {
    child.kill("SIGTERM");
    // Give the process up to 3s to exit cleanly
    await Promise.race([
      new Promise<void>((res) => child.on("exit", res)),
      delay(3_000),
    ]);
    if (!child.killed) child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("preview.sh contract", () => {
  // Each test gets its own DB file so they can run independently
  let child: ChildProcess | undefined;
  let dbPath: string;

  test.afterEach(async () => {
    if (child) {
      await killAndWait(child);
      child = undefined;
    }
    if (dbPath && existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  // ---- Test 1: prints the URL ------------------------------------------------

  test('preview.sh prints "http://localhost:3000" within 30s', async () => {
    dbPath = makeTempDbPath("url-print");

    // This will reject (and the test will fail) until preview.sh actually
    // starts Next.js and emits the URL line — currently it only prints a
    // placeholder, so it exits immediately without the URL.
    child = await spawnPreviewSh(dbPath);

    // Verify child process is still running (server is up)
    expect(child.exitCode).toBeNull();
  });

  // ---- Test 2: GET / returns 200 with app shell ------------------------------

  test("GET http://localhost:3000/ returns 200 with app-shell marker after preview.sh starts", async () => {
    dbPath = makeTempDbPath("get-200");

    child = await spawnPreviewSh(dbPath);

    // Give the server a moment to finish binding after printing the URL
    await delay(1_000);

    const res = await fetch(APP_URL, { redirect: "follow" });
    expect(res.status).toBe(200);

    const html = await res.text();
    // Must contain the app name as the root-endpoint test also asserts
    expect(html).toContain("ArbWatch");
  });

  // ---- Test 3: idempotency ---------------------------------------------------

  test("preview.sh is idempotent — second run against seeded DB does not duplicate rows", async () => {
    dbPath = makeTempDbPath("idempotency");

    // === First run ===
    child = await spawnPreviewSh(dbPath);
    // Server is up; kill it so we can run preview.sh again
    await killAndWait(child);
    child = undefined;

    // Give the process a moment to release the file lock
    await delay(500);

    // === Second run ===
    // This call must also succeed (exit via URL print, not premature exit)
    child = await spawnPreviewSh(dbPath);
    // Kill again; we just need it to start cleanly
    await killAndWait(child);
    child = undefined;

    // === Verify no row duplication ===
    // Open the DB directly with better-sqlite3 to check counts
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const userCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number }
      ).cnt;
      const questionCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM watched_questions")
          .get() as { cnt: number }
      ).cnt;

      expect(userCount).toBe(1); // Not 2 after two runs
      expect(questionCount).toBe(3); // Not 6 after two runs
    } finally {
      db.close();
    }
  });
});
