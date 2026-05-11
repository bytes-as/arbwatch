/**
 * tests/server/key-server-setup.ts
 *
 * Vitest setupFile for tests/key/*.test.ts (key project in vitest.workspace.ts).
 *
 * Responsibilities:
 * 1. Before each request dispatch, scans the known test DB directories to find
 *    the MOST RECENTLY MODIFIED DB file that contains the session token.
 *    Since tests seed their DBs right before running, the most-recently-modified
 *    DB is the one belonging to the current test suite.
 *
 * 2. Wraps each route handler call in testDbUrlStore.run(url, ...) so that
 *    getDb() always uses the correct DB for this request.
 *
 * 3. Intercepts fetch() calls to http://localhost:3000 for in-process dispatch.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { testDbUrlStore } from "../../db/client";

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ??
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.NODE_ENV = "test";
process.env.SKIP_CSRF_CHECK = "true";
process.env.ENABLE_TEST_ROUTES = "true";
process.env.WIRE_MODE = process.env.WIRE_MODE ?? "fixtures";
process.env.PREDMKT_KEY_TEST = "true";

// ---------------------------------------------------------------------------
// Known test DB directories
// ---------------------------------------------------------------------------

const KNOWN_TEST_DIRS = [
  join(tmpdir(), "predmkt-arb-key-tests"),
  join(tmpdir(), "predmkt-arb-rotation-tests"),
  join(tmpdir(), "predmkt-arb-isolation-tests"),
];

interface DbFile {
  filePath: string;
  mtime: number;
}

/**
 * Return all existing .db files from the known test directories,
 * sorted by modification time (most recent first).
 */
function findAllTestDbFiles(): DbFile[] {
  const files: DbFile[] = [];
  for (const dir of KNOWN_TEST_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const f of entries) {
        if (!f.endsWith(".db")) continue;
        const filePath = join(dir, f);
        try {
          const mtime = statSync(filePath).mtimeMs;
          files.push({ filePath, mtime });
        } catch {
          // file disappeared between readdir and stat — skip
        }
      }
    } catch {
      // ignore dir read errors
    }
  }
  // Sort: most recently modified first
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// ---------------------------------------------------------------------------
// IPC file fallback
// ---------------------------------------------------------------------------

const IPC_FILE = join(tmpdir(), ".predmkt-test-current-db-url");

function readIpcDbUrl(): string | null {
  if (existsSync(IPC_FILE)) {
    const url = readFileSync(IPC_FILE, "utf8").trim();
    return url || null;
  }
  return null;
}

// Set initial DATABASE_URL from IPC
const initialUrl = readIpcDbUrl();
if (initialUrl) {
  process.env.DATABASE_URL = initialUrl;
}

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

/**
 * Try to find the userId for a session token in a given DB file.
 * Returns null if not found or the DB has no sessions table.
 */
function findUserIdInDb(filePath: string, sessionToken: string): string | null {
  if (!existsSync(filePath)) return null;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(filePath, { readonly: true });
    const row = db
      .prepare(
        "SELECT userId FROM sessions WHERE sessionToken = ? AND expires > ?"
      )
      .get(sessionToken, Date.now()) as { userId: string } | undefined;
    return row?.userId ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Extract the session token from a request's Cookie header.
 */
function extractSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf("=");
    if (eqIdx === -1) continue;
    const name = cookie.slice(0, eqIdx).trim();
    const value = cookie.slice(eqIdx + 1).trim();
    if (
      name === "next-auth.session-token" ||
      name === "authjs.session-token" ||
      name === "__Secure-next-auth.session-token"
    ) {
      return value;
    }
  }
  return null;
}

/**
 * Find the DB file path that contains the given session token.
 * Returns the MOST RECENTLY MODIFIED file that has the session.
 * Returns null if not found.
 */
function findDbPathForSession(sessionToken: string): string | null {
  const files = findAllTestDbFiles();
  for (const { filePath } of files) {
    const userId = findUserIdInDb(filePath, sessionToken);
    if (userId !== null) return filePath;
  }
  return null;
}

/**
 * Determine the DATABASE_URL to use for a given request.
 *
 * Strategy: IPC file is the authoritative source because runSeed() always
 * writes it right before a test suite runs. Session-based scanning is
 * unreliable because leftover .db files from previous runs also contain the
 * fixture session tokens and may have newer mtimes.
 */
function resolveDbUrlForRequest(request: Request): string {
  // IPC file: most-recently seeded DB — this is authoritative in single-worker mode.
  const ipcUrl = readIpcDbUrl();
  if (ipcUrl) {
    if (ipcUrl !== process.env.DATABASE_URL) {
      process.env.DATABASE_URL = ipcUrl;
    }
    return ipcUrl;
  }

  // Fallback: session-based scan (handles edge cases where IPC is absent).
  const sessionToken = extractSessionToken(request);
  if (sessionToken) {
    const filePath = findDbPathForSession(sessionToken);
    if (filePath) {
      const url = `file:${filePath}`;
      if (url !== process.env.DATABASE_URL) {
        process.env.DATABASE_URL = url;
      }
      return url;
    }
  }

  return process.env.DATABASE_URL ?? "file:./local.db";
}

// ---------------------------------------------------------------------------
// In-process route dispatcher
// ---------------------------------------------------------------------------

const { NextRequest } = await import("next/server");

async function dispatchWithDb<T>(
  dbUrl: string,
  fn: () => Promise<T>
): Promise<T> {
  return testDbUrlStore.run(dbUrl, fn);
}

async function dispatchToHandler(request: Request): Promise<Response> {
  const dbUrl = resolveDbUrlForRequest(request);

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/api/me/anakin-key/probe") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/me/anakin-key/probe/route.ts");
        const nextReq = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body:
            request.method !== "GET" && request.method !== "HEAD"
              ? request.body
              : undefined,
        });
        return (mod.POST as (req: any) => Promise<Response>)(nextReq);
      } catch (err) {
        console.error("[key-setup] probe handler error:", err);
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  if (pathname === "/api/me/anakin-key") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/me/anakin-key/route.ts");
        const nextReq = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body:
            request.method !== "GET" && request.method !== "HEAD"
              ? request.body
              : undefined,
        });
        if (request.method === "POST") {
          return (mod.POST as (req: any) => Promise<Response>)(nextReq);
        } else if (request.method === "DELETE") {
          return (mod.DELETE as (req: any) => Promise<Response>)(nextReq);
        } else {
          return (mod.GET as (req: any) => Promise<Response>)(nextReq);
        }
      } catch (err) {
        console.error("[key-setup] anakin-key handler error:", err);
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  if (pathname === "/api/me") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/me/route.ts");
        const nextReq = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
        });
        return (mod.GET as (req: any) => Promise<Response>)(nextReq);
      } catch (err) {
        console.error("[key-setup] /api/me error:", err);
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  return new Response(`Not found: ${pathname}`, {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// Intercept global fetch for in-process dispatch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

(globalThis as any).fetch = async function keyTestFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  let urlStr: string;
  let req: Request;

  if (typeof input === "string") {
    urlStr = input;
    req = new Request(input, init);
  } else if (input instanceof URL) {
    urlStr = input.toString();
    req = new Request(input, init);
  } else if (input instanceof Request) {
    urlStr = input.url;
    req = init ? new Request(input, init) : input.clone();
  } else {
    urlStr = String(input);
    req = new Request(urlStr, init);
  }

  if (
    urlStr.startsWith("http://localhost:3000/") ||
    urlStr === "http://localhost:3000"
  ) {
    try {
      const response = await dispatchToHandler(req);
      Object.defineProperty(response, "url", {
        value: urlStr,
        configurable: true,
      });
      return response;
    } catch (err) {
      console.error("[key-setup] dispatch error:", err);
      return new Response(`Internal error: ${err}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  return realFetch(input, init);
};
