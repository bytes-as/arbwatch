/**
 * tests/server/watched-server-setup.ts
 *
 * Vitest setupFile for tests/watched/*.test.ts.
 *
 * This file extends key-server-setup.ts by intercepting fetch() calls to
 * http://localhost:3000/api/watched* and routing them to the watched-question
 * route handlers once those handlers are implemented (task-watched-backend).
 *
 * CURRENT STATE (Mode 1 / pre-implementation):
 *   The /api/watched route handlers do not exist yet. This setup returns 404
 *   for all /api/watched requests, which causes all tests in crud.test.ts to
 *   fail as expected — that is the correct Mode 1 behaviour.
 *
 * IMPLEMENTATION GATE (task-watched-backend):
 *   When the implementer creates:
 *     app/api/watched/route.ts       (GET + POST)
 *     app/api/watched/[id]/route.ts  (DELETE)
 *   they must also update this file to import and dispatch to those handlers.
 *   The dispatch pattern mirrors tests/server/key-server-setup.ts exactly.
 *
 * Responsibilities:
 *   1. Set environment variables (same as key-server-setup.ts).
 *   2. Wrap each route handler call in testDbUrlStore.run(url, ...) so that
 *      getDb() always uses the correct DB for this request.
 *   3. Intercept fetch() calls to http://localhost:3000 for in-process dispatch.
 *      - /api/watched         → GET + POST handlers
 *      - /api/watched/:id     → DELETE handler
 *      - /api/me/anakin-key*  → delegated to key-server-setup handlers
 *      - /api/me              → delegated to key-server-setup handlers
 *
 * DB URL resolution:
 *   Uses the same IPC file strategy as key-server-setup.ts:
 *   runSeed() writes DATABASE_URL to /tmp/.predmkt-test-current-db-url before
 *   each test suite runs; this setup reads it for every in-process dispatch.
 */

import { beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { testDbUrlStore } from "../../db/client";

// ---------------------------------------------------------------------------
// Environment defaults (must run before any NextAuth/Drizzle imports)
// ---------------------------------------------------------------------------

process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ??
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.NODE_ENV = "test";
process.env.ENABLE_TEST_ROUTES = "true";
process.env.WIRE_MODE = process.env.WIRE_MODE ?? "fixtures";

// ---------------------------------------------------------------------------
// Known test DB directories
// ---------------------------------------------------------------------------

const KNOWN_TEST_DIRS = [
  join(tmpdir(), "predmkt-arb-watched-tests"),
  join(tmpdir(), "predmkt-arb-key-tests"),
  join(tmpdir(), "predmkt-arb-rotation-tests"),
  join(tmpdir(), "predmkt-arb-isolation-tests"),
  join(tmpdir(), "predmkt-arb-multiuser-tests"),
];

interface DbFile {
  filePath: string;
  mtime: number;
}

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
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// ---------------------------------------------------------------------------
// IPC file (authoritative DB URL)
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

function resolveDbUrlForRequest(request: Request): string {
  const ipcUrl = readIpcDbUrl();
  if (ipcUrl) {
    if (ipcUrl !== process.env.DATABASE_URL) {
      process.env.DATABASE_URL = ipcUrl;
    }
    return ipcUrl;
  }

  const sessionToken = extractSessionToken(request);
  if (sessionToken) {
    for (const { filePath } of findAllTestDbFiles()) {
      const userId = findUserIdInDb(filePath, sessionToken);
      if (userId !== null) {
        const url = `file:${filePath}`;
        if (url !== process.env.DATABASE_URL) {
          process.env.DATABASE_URL = url;
        }
        return url;
      }
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

  // ---------------------------------------------------------------------------
  // /api/watched routes — task-watched-backend
  // ---------------------------------------------------------------------------

  if (pathname === "/api/watched") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/watched/route.ts");
        const nextReq = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        });
        if (request.method === "GET") {
          return (mod.GET as (req: any) => Promise<Response>)(nextReq);
        } else if (request.method === "POST") {
          return (mod.POST as (req: any) => Promise<Response>)(nextReq);
        }
        return new Response("Method Not Allowed", { status: 405 });
      } catch (err) {
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  const watchedIdMatch = pathname.match(/^\/api\/watched\/([^/]+)$/);
  if (watchedIdMatch) {
    const id = watchedIdMatch[1];
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/watched/[id]/route.ts");
        const nextReq = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body:
            request.method !== "GET" && request.method !== "HEAD"
              ? request.body
              : undefined,
        });
        if (request.method === "DELETE") {
          return (mod.DELETE as (req: any, ctx: any) => Promise<Response>)(nextReq, { params: { id } });
        } else if (request.method === "PATCH") {
          return (mod.PATCH as (req: any, ctx: any) => Promise<Response>)(nextReq, { params: { id } });
        }
        return new Response("Method Not Allowed", { status: 405 });
      } catch (err) {
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // /api/me/anakin-key routes — delegate to the key handler
  // ---------------------------------------------------------------------------

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
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  if (pathname === "/api/me/push-subscriptions") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/me/push-subscriptions/route.ts");
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
        }
        return new Response("Method Not Allowed", { status: 405 });
      } catch (err) {
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // /api/cron/refresh-spreads — cron handler (POST or GET)
  // ---------------------------------------------------------------------------

  if (pathname === "/api/cron/refresh-spreads") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/cron/refresh-spreads/route.ts");
        const nextReq = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body:
            request.method !== "GET" && request.method !== "HEAD"
              ? request.body
              : undefined,
        });
        const handler = ((mod as any).POST ?? (mod as any).GET) as
          | ((req: any) => Promise<Response>)
          | undefined;
        if (!handler) return new Response("No handler", { status: 500 });
        return handler(nextReq);
      } catch (err) {
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // /api/test-set-key-status — test-only key status mutation
  // ---------------------------------------------------------------------------

  if (pathname === "/api/test-set-key-status") {
    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/test-set-key-status/route.ts");
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
        return new Response(`Error: ${err}`, { status: 500 });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // /api/auth/* — NextAuth handler (magic-link sign-in / callback)
  // ---------------------------------------------------------------------------

  if (pathname.startsWith("/api/auth/")) {
    // For the email callback, the test may pass the hashed token from
    // verification_tokens (as read from the DB). Rewrite the request to use
    // the raw token from global.__testResendInbox instead, so NextAuth's
    // token verification succeeds.
    let effectiveRequest = request;
    if (pathname === "/api/auth/callback/email" && request.method === "GET") {
      const callbackUrl = new URL(request.url);
      const paramEmail = callbackUrl.searchParams.get("email") ?? "";
      if (paramEmail) {
        const inbox: Array<{ html?: string; text?: string; to: string | string[] }> =
          (global as any).__testResendInbox ?? [];
        const lastEmail = [...inbox]
          .reverse()
          .find((e) => {
            const to = Array.isArray(e.to) ? e.to : [e.to];
            return to.includes(paramEmail);
          });
        if (lastEmail) {
          const body = lastEmail.html ?? lastEmail.text ?? "";
          const tokenMatch = body.match(/callback\/email\?[^"<\s]*token=([^&"<>\s]+)/);
          if (tokenMatch) {
            const rawToken = decodeURIComponent(tokenMatch[1]);
            callbackUrl.searchParams.set("token", rawToken);
            effectiveRequest = new Request(callbackUrl.toString(), {
              method: request.method,
              headers: request.headers,
            });
          }
        }
      }
    }

    return dispatchWithDb(dbUrl, async () => {
      try {
        const mod = await import("../../app/api/auth/[...nextauth]/route.ts");
        const nextReq = new NextRequest(effectiveRequest.url, {
          method: effectiveRequest.method,
          headers: effectiveRequest.headers,
          body:
            effectiveRequest.method !== "GET" && effectiveRequest.method !== "HEAD"
              ? effectiveRequest.body
              : undefined,
        });
        let response: Response;
        if (effectiveRequest.method === "GET") {
          response = await (mod.GET as (req: any) => Promise<Response>)(nextReq);
        } else {
          response = await (mod.POST as (req: any) => Promise<Response>)(nextReq);
        }
        return response;
      } catch (err) {
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
// Per-test cleanup: clear in-memory caches so hysteresis and idempotency
// state from one test block doesn't bleed into the next.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  try {
    const { clearIdempotencyCache } = await import("../../lib/cron.js");
    clearIdempotencyCache();
  } catch {
    // lib/cron.ts may not expose clearIdempotencyCache — ignore
  }
  try {
    const { clearAlertsCache } = await import("../../lib/alerts.js");
    clearAlertsCache();
  } catch {
    // lib/alerts.ts may not exist or export clearAlertsCache — ignore
  }
});

// ---------------------------------------------------------------------------
// Intercept global fetch for in-process dispatch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

(globalThis as any).fetch = async function watchedTestFetch(
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
      return new Response(`Internal error: ${err}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  return realFetch(input, init);
};
