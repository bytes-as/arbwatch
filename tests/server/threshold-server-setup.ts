/**
 * tests/server/threshold-server-setup.ts
 *
 * Vitest setupFile for tests/thresholds/*.test.ts.
 *
 * Extends matching-setup.ts by:
 *   1. Inserting a fixture session into local.db so TH2 PATCH tests can
 *      authenticate via the fixture session cookie.
 *   2. Intercepting fetch() for http://localhost:3000 to route PATCH requests
 *      to app/api/watched/[id]/route.ts for in-process dispatch.
 *
 * TH1/TH3-TH9 use temp DBs seeded via scripts/seed.ts and invoke
 * lib/alerts.ts directly — those tests do not go through the fetch interceptor.
 *
 * TH2 makes HTTP fetch calls to validate the PATCH endpoint shape.
 * Those calls are intercepted here and routed to the in-process PATCH handler.
 */

import { beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import yaml from "yaml";

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ??
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.NODE_ENV = "test";
process.env.SKIP_CSRF_CHECK = "true";
process.env.WIRE_MODE = process.env.WIRE_MODE ?? "fixtures";
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

const REPO_ROOT = join(new URL("../../", import.meta.url).pathname).replace(/\/$/, "");

const DB_URL = process.env.DATABASE_URL ?? "file:./local.db";
const DB_FILE = DB_URL.startsWith("file:") ? DB_URL.slice(5) : DB_URL;

// ---------------------------------------------------------------------------
// Open DB and apply migrations
// ---------------------------------------------------------------------------

const sqlite = new Database(DB_FILE);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: join(REPO_ROOT, "drizzle") });

// Ensure the threshold column exists on watched_questions in local.db.
// Local.db may have partial migrations applied (0-2 only) without the later
// manual migrations (0003-0006). We apply missing DDL idempotently here.
const existingTables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spread_snapshots'")
  .get();

if (!existingTables) {
  // Apply the remaining migrations (0003-0006) that Drizzle skips because they
  // were added manually without snapshots and the DB already has a migration table.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS \`spread_snapshots\` (
      \`id\` text PRIMARY KEY NOT NULL,
      \`question_id\` text NOT NULL,
      \`spread\` real,
      \`last_updated\` integer NOT NULL,
      \`computed_at\` integer NOT NULL,
      FOREIGN KEY (\`question_id\`) REFERENCES \`watched_questions\`(\`id\`) ON UPDATE no action ON DELETE cascade
    );
  `);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`spread_snapshots_question_id_unique\` ON \`spread_snapshots\` (\`question_id\`);`);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS \`alerts\` (
      \`id\` text PRIMARY KEY NOT NULL,
      \`question_id\` text NOT NULL,
      \`user_id\` text NOT NULL,
      \`state\` text NOT NULL,
      \`last_alerted_at\` integer,
      \`last_alerted_spread\` real,
      FOREIGN KEY (\`question_id\`) REFERENCES \`watched_questions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
      CONSTRAINT \`alerts_state_check\` CHECK(\`state\` IN ('armed', 'fired'))
    );
  `);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS \`alerts_question_id_user_id_unique\` ON \`alerts\` (\`question_id\`, \`user_id\`);`);
}

// Add threshold column to watched_questions if missing (from migration 0006)
const wqCols = sqlite.prepare("PRAGMA table_info(watched_questions)").all() as Array<{ name: string }>;
if (!wqCols.some((c) => c.name === "threshold")) {
  sqlite.exec("ALTER TABLE `watched_questions` ADD `threshold` real;");
}

// ---------------------------------------------------------------------------
// Seed fixture users and session
// ---------------------------------------------------------------------------

const queriesYamlPath = join(REPO_ROOT, "tests", "seeds", "queries.yaml");
const queriesData = yaml.parse(readFileSync(queriesYamlPath, "utf8")) as {
  fixture_user: { id: string; email: string; anakin_key_status: string };
  fixture_user_no_key: { id: string; email: string; anakin_key_status: string };
};

const { encrypt } = await import("../../db/encryption.js");
const fixtureKey = encrypt(
  "fixture-anakin-key-for-testing-only",
  queriesData.fixture_user.id
);

sqlite
  .prepare(
    `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       anakin_key_ct = excluded.anakin_key_ct,
       anakin_key_status = excluded.anakin_key_status`
  )
  .run(
    queriesData.fixture_user.id,
    queriesData.fixture_user.email,
    fixtureKey,
    queriesData.fixture_user.anakin_key_status
  );

sqlite
  .prepare(
    `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
     VALUES (?, ?, NULL, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       anakin_key_ct = NULL,
       anakin_key_status = excluded.anakin_key_status`
  )
  .run(
    queriesData.fixture_user_no_key.id,
    queriesData.fixture_user_no_key.email,
    queriesData.fixture_user_no_key.anakin_key_status
  );

// Insert fixture session so TH2 PATCH requests authenticate correctly
const FIXTURE_SESSION_TOKEN = "fixture-session-token-do-not-use-in-prod";
const sessionExpires = Date.now() + 30 * 24 * 60 * 60 * 1000;

sqlite
  .prepare(
    `INSERT INTO sessions (sessionToken, userId, expires)
     VALUES (?, ?, ?)
     ON CONFLICT(sessionToken) DO UPDATE SET expires = excluded.expires`
  )
  .run(FIXTURE_SESSION_TOKEN, queriesData.fixture_user.id, sessionExpires);

// ---------------------------------------------------------------------------
// Seed matching-query watched_questions rows (same as matching-setup.ts)
// ---------------------------------------------------------------------------

const matchingYamlPath = join(REPO_ROOT, "tests", "seeds", "matching-queries.yaml");
const matchingData = yaml.parse(readFileSync(matchingYamlPath, "utf8")) as {
  matching_questions: Array<{
    id: string;
    query_text: string;
    user_id: string;
  }>;
};

const insertQuestion = sqlite.prepare(
  `INSERT INTO watched_questions (id, user_id, query_text, created_at)
   VALUES (?, ?, ?, unixepoch())
   ON CONFLICT(id) DO NOTHING`
);

for (const q of matchingData.matching_questions) {
  insertQuestion.run(q.id, q.user_id, q.query_text);
}

sqlite.close();

// ---------------------------------------------------------------------------
// Per-test cleanup: clear in-memory caches
// ---------------------------------------------------------------------------

beforeEach(async () => {
  try {
    const { clearIdempotencyCache } = await import("../../lib/cron.js");
    clearIdempotencyCache();
  } catch {
    // lib/cron.ts may not expose clearIdempotencyCache
  }
  try {
    const { clearAlertsCache } = await import("../../lib/alerts.js");
    clearAlertsCache();
  } catch {
    // lib/alerts.ts may not exist pre-implementation
  }
});

// ---------------------------------------------------------------------------
// In-process fetch interceptor for TH2 PATCH requests
// ---------------------------------------------------------------------------

const { NextRequest } = await import("next/server");

async function dispatchToHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const watchedIdMatch = pathname.match(/^\/api\/watched\/([^/]+)$/);
  if (watchedIdMatch) {
    const id = watchedIdMatch[1];
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
  }

  if (pathname === "/api/me/push-subscriptions") {
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
  }

  return new Response(`Not found: ${pathname}`, {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

const realFetch = globalThis.fetch;

(globalThis as any).fetch = async function thresholdTestFetch(
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
