/**
 * tests/webpush/webpush.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - db/schema.ts adds a `push_subscriptions` table
 *     (id, user_id FK, endpoint TEXT, p256dh TEXT, auth TEXT, created_at INTEGER)
 *   - A migration adds the table to SQLite
 *   - POST /api/me/push-subscriptions persists a subscription for the authenticated user
 *   - DELETE /api/me/push-subscriptions removes a subscription by endpoint
 *   - lib/alerts.ts dispatchAlerts() fans out to both email AND active push subscriptions
 *   - lib/alerts.ts imports web-push and calls webpush.sendNotification() per subscription
 *   - VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars configure web-push
 *
 * DoD items covered:
 *   WP1 — Schema: push_subscriptions table exists with correct columns
 *   WP2 — POST /api/me/push-subscriptions persists a subscription (auth-gated)
 *   WP3 — Threshold cross fires web-push sendNotification() (mocked) AND email
 *   WP4 — Hysteresis holds across dual-transport: second tick above threshold suppresses both
 *   WP5 — DELETE /api/me/push-subscriptions removes a subscription by endpoint
 *   WP6 — No web-push when user has no subscriptions (email-only fallback)
 *   WP7 — Multiple subscriptions: all active subscriptions receive the notification
 *
 * Architecture references:
 *   lib/alerts.ts      — dispatchAlerts(), sendAlert(), web-push fan-out
 *   db/schema.ts       — push_subscriptions table
 *   app/api/me/push-subscriptions/route.ts — POST and DELETE handlers
 *   tests/auth/__mocks__/resend.ts — in-memory Resend mock
 *   tests/cron/helpers/cron-fixtures.ts — fixture users, questions, DB helpers
 *
 * Test approach:
 *   - vi.mock("resend") replaces Resend with the in-memory mock
 *   - vi.mock("web-push") replaces web-push with an in-memory tracker
 *   - Each test seeds its own temp SQLite DB via scripts/seed.ts
 *   - Alert dispatch is invoked directly via lib/alerts.ts dispatchAlerts()
 *   - Subscription CRUD is invoked via in-process fetch to http://localhost:3000
 *     (threshold-server-setup.ts must dispatch /api/me/push-subscriptions requests;
 *      until it does, WP2/WP5 will fail with 404 — correct Mode 1 failure)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { existsSync, writeFileSync } from "node:fs";

import {
  clearInbox,
  getInbox,
} from "../auth/__mocks__/resend";

import {
  REPO_ROOT,
  TEST_APP_ENCRYPTION_KEY,
  FIXTURE_USER_WITH_KEY,
  FIXTURE_QUESTIONS,
  TEST_CRON_SECRET,
} from "../cron/helpers/cron-fixtures";

/** IPC file that watched-server-setup.ts reads to resolve DATABASE_URL. */
const IPC_FILE = join(tmpdir(), ".predmkt-test-current-db-url");

// ---------------------------------------------------------------------------
// Mocks — must be declared before any module that imports these loads
// ---------------------------------------------------------------------------

vi.mock("resend");

/**
 * In-memory web-push mock.
 *
 * Tracks calls to sendNotification(). The real web-push module is replaced so
 * no actual VAPID HTTP calls are made. Tests inspect pushSentTo[] to assert
 * which subscriptions received a notification.
 *
 * When web-push is not yet installed / not yet imported in lib/alerts.ts,
 * this mock simply won't be called — which means pushSentTo will be empty
 * and WP3/WP4/WP7 will fail with a meaningful assertion error.
 */
interface MockPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const pushSentTo: MockPushSubscription[] = [];

function clearPushInbox(): void {
  pushSentTo.length = 0;
}

function getPushSentTo(): MockPushSubscription[] {
  return [...pushSentTo];
}

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (subscription: MockPushSubscription) => {
      pushSentTo.push(subscription);
      return { statusCode: 201 };
    }),
  },
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (subscription: MockPushSubscription) => {
    pushSentTo.push(subscription);
    return { statusCode: 201 };
  }),
}));

// ---------------------------------------------------------------------------
// Expected schema constants
// ---------------------------------------------------------------------------

export const EXPECTED_PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";
export const EXPECTED_PUSH_SUBSCRIPTIONS_COLUMNS = [
  "id",
  "user_id",
  "endpoint",
  "p256dh",
  "auth",
  "created_at",
] as const;

// ---------------------------------------------------------------------------
// VAPID test keys (deterministic, never use in production)
// ---------------------------------------------------------------------------

export const TEST_VAPID_PUBLIC_KEY =
  "BNbvRKWoFPJRnP9cG4bYrBEGD7s9xDLjS5Ydb6z8w8P2X0ZlV2QsNTaUJ9xYCvBpfD0PgXkVzYX2ZvBwBEDmwrY=";
export const TEST_VAPID_PRIVATE_KEY = "testVapidPrivateKeyBase64urlEncoded1234";
export const TEST_VAPID_SUBJECT = "mailto:test@arbwatch.test";

// ---------------------------------------------------------------------------
// Fixture push subscription
// ---------------------------------------------------------------------------

export const FIXTURE_PUSH_SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/fixture-endpoint-001",
  p256dh: "BHFixturePublicKeyP256dh001=",
  auth: "fixtureAuth001==",
} as const;

export const FIXTURE_PUSH_SUBSCRIPTION_2 = {
  endpoint: "https://fcm.googleapis.com/fcm/send/fixture-endpoint-002",
  p256dh: "BHFixturePublicKeyP256dh002=",
  auth: "fixtureAuth002==",
} as const;

// ---------------------------------------------------------------------------
// Temp DB + seed helpers (same pattern as alerts.test.ts)
// ---------------------------------------------------------------------------

const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-webpush-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `webpush-${suffix}-${process.pid}.db`);
}

function runSeed(targetDbPath: string): void {
  const dbUrl = `file:${targetDbPath}`;
  // Write IPC file so watched-server-setup.ts resolves the DB URL for in-process route dispatch
  writeFileSync(IPC_FILE, dbUrl, "utf8");
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      WIRE_MODE: "fixtures",
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "test",
      PREDMKT_CRON_TEST: "true",
      PREDMKT_KEY_TEST: "true",
      PREDMKT_SEED_MATCHES: "true",
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: TEST_VAPID_SUBJECT,
    },
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
  process.env.DATABASE_URL = dbUrl;
}

function seedSpreadSnapshot(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  spread: number | null,
  nowMs: number
): void {
  const nowSec = Math.floor(nowMs / 1000);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`
    )
    .run(questionId, spread, nowSec, nowSec);
}

/**
 * Insert a push subscription row directly into the DB (bypasses the API for setup).
 * Used in tests that need a pre-existing subscription before dispatch.
 * WP2/WP5 test via the API endpoint.
 */
function insertPushSubscription(
  sqlite: InstanceType<typeof Database>,
  userId: string,
  sub: { endpoint: string; p256dh: string; auth: string }
): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO ${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE}
         (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, unixepoch())`
    )
    .run(userId, sub.endpoint, sub.p256dh, sub.auth);
}

// ---------------------------------------------------------------------------
// Alert dispatch invocation helper
// ---------------------------------------------------------------------------

async function invokeAlertDispatch(dbPath: string, nowMs: number): Promise<void> {
  const { dispatchAlerts } = await import("../../lib/alerts.js");
  await dispatchAlerts(dbPath, nowMs);
}

// ---------------------------------------------------------------------------
// WP1 — Schema: push_subscriptions table exists
// ---------------------------------------------------------------------------

describe("WP1 — Schema: push_subscriptions table", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("wp1");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("push_subscriptions table exists", () => {
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      )
      .all(EXPECTED_PUSH_SUBSCRIPTIONS_TABLE) as Array<{ name: string }>;

    expect(
      tables.length,
      `Table '${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE}' does not exist in the database. ` +
        `Add it to db/schema.ts and create a migration.`
    ).toBe(1);
  });

  it("push_subscriptions has the expected columns", () => {
    const cols = sqlite
      .prepare(`PRAGMA table_info(${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE})`)
      .all() as Array<{ name: string }>;

    const colNames = cols.map((c) => c.name);

    for (const expected of EXPECTED_PUSH_SUBSCRIPTIONS_COLUMNS) {
      expect(
        colNames,
        `Column '${expected}' is missing from '${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE}'. ` +
          `Expected columns: ${EXPECTED_PUSH_SUBSCRIPTIONS_COLUMNS.join(", ")}.`
      ).toContain(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// WP2 — POST /api/me/push-subscriptions persists a subscription
// ---------------------------------------------------------------------------

describe("WP2 — POST /api/me/push-subscriptions persists a subscription", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("wp2");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("POST /api/me/push-subscriptions with valid body returns 201 and persists the row", async () => {
    const sessionToken = process.env.FIXTURE_SESSION_TOKEN ??
      "fixture-session-token-do-not-use-in-prod";

    const res = await fetch("http://localhost:3000/api/me/push-subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `next-auth.session-token=${sessionToken}`,
      },
      body: JSON.stringify({
        endpoint: FIXTURE_PUSH_SUBSCRIPTION.endpoint,
        p256dh: FIXTURE_PUSH_SUBSCRIPTION.p256dh,
        auth: FIXTURE_PUSH_SUBSCRIPTION.auth,
      }),
    });

    expect(
      res.status,
      `POST /api/me/push-subscriptions returned ${res.status}. Expected 201. ` +
        `Create the route at app/api/me/push-subscriptions/route.ts. ` +
        `It must accept { endpoint, p256dh, auth } and persist to push_subscriptions.`
    ).toBe(201);

    const row = sqlite
      .prepare(
        `SELECT * FROM ${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE} WHERE endpoint = ?`
      )
      .get(FIXTURE_PUSH_SUBSCRIPTION.endpoint) as
      | { user_id: string; endpoint: string; p256dh: string; auth: string }
      | undefined;

    expect(
      row,
      `No row found in push_subscriptions for endpoint '${FIXTURE_PUSH_SUBSCRIPTION.endpoint}' ` +
        `after POST. The route must write to the push_subscriptions table.`
    ).toBeDefined();

    expect(row?.user_id).toBe(FIXTURE_USER_WITH_KEY.id);
    expect(row?.p256dh).toBe(FIXTURE_PUSH_SUBSCRIPTION.p256dh);
    expect(row?.auth).toBe(FIXTURE_PUSH_SUBSCRIPTION.auth);
  });

  it("POST /api/me/push-subscriptions is auth-gated: unauthenticated request returns 401", async () => {
    const res = await fetch("http://localhost:3000/api/me/push-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/unauth-test",
        p256dh: "BHtest=",
        auth: "authtest==",
      }),
    });

    expect(
      res.status,
      `Unauthenticated POST /api/me/push-subscriptions returned ${res.status}. Expected 401. ` +
        `The route must reject requests without a valid session.`
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// WP3 — Threshold cross fires web-push AND email
// ---------------------------------------------------------------------------

describe("WP3 — Threshold cross fires web-push sendNotification() and email", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;
  const NOW = Date.now();
  const Q = FIXTURE_QUESTIONS[0];

  beforeAll(() => {
    dbPath = makeTempDbPath("wp3");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  beforeEach(() => {
    clearInbox();
    clearPushInbox();
  });

  it("dispatch with one subscription fires sendNotification() once", async () => {
    insertPushSubscription(sqlite, FIXTURE_USER_WITH_KEY.id, FIXTURE_PUSH_SUBSCRIPTION);
    seedSpreadSnapshot(sqlite, Q.id, 0.04, NOW);

    await invokeAlertDispatch(dbPath, NOW);

    const sent = getPushSentTo();
    expect(
      sent.length,
      `Expected 1 web-push sendNotification() call, got ${sent.length}. ` +
        `lib/alerts.ts must call webpush.sendNotification() for each active subscription ` +
        `when a threshold is crossed. ` +
        `Ensure VAPID env vars are configured and web-push is imported in lib/alerts.ts.`
    ).toBe(1);

    expect(sent[0].endpoint).toBe(FIXTURE_PUSH_SUBSCRIPTION.endpoint);
  });

  it("dispatch also fires the email transport when push is active", async () => {
    insertPushSubscription(sqlite, FIXTURE_USER_WITH_KEY.id, FIXTURE_PUSH_SUBSCRIPTION);
    seedSpreadSnapshot(sqlite, Q.id, 0.04, NOW + 1000);

    await invokeAlertDispatch(dbPath, NOW + 1000);

    const emails = getInbox();
    expect(
      emails.length,
      `Expected 1 email alert when a push subscription is active, got ${emails.length}. ` +
        `web-push is an ADDITIONAL transport — it must not replace the email transport.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WP4 — Hysteresis holds across dual-transport dispatch
// ---------------------------------------------------------------------------

describe("WP4 — Hysteresis holds across dual-transport: second tick suppresses both transports", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;
  const NOW = Date.now();
  const Q = FIXTURE_QUESTIONS[0];

  beforeAll(() => {
    dbPath = makeTempDbPath("wp4");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  beforeEach(() => {
    clearInbox();
    clearPushInbox();
  });

  it("first tick fires both email and push; second tick above threshold fires neither", async () => {
    insertPushSubscription(sqlite, FIXTURE_USER_WITH_KEY.id, FIXTURE_PUSH_SUBSCRIPTION);
    seedSpreadSnapshot(sqlite, Q.id, 0.04, NOW);

    // First tick: should fire
    await invokeAlertDispatch(dbPath, NOW);

    const emailsAfterFirst = getInbox().length;
    const pushAfterFirst = getPushSentTo().length;

    expect(emailsAfterFirst, "First tick should fire 1 email").toBe(1);
    expect(pushAfterFirst, "First tick should fire 1 push notification").toBe(1);

    // Clear inboxes but NOT the hysteresis cache — state persists across ticks
    clearInbox();
    clearPushInbox();

    // Second tick, still above threshold
    seedSpreadSnapshot(sqlite, Q.id, 0.05, NOW + 60_000);
    await invokeAlertDispatch(dbPath, NOW + 60_000);

    const emailsAfterSecond = getInbox().length;
    const pushAfterSecond = getPushSentTo().length;

    expect(
      emailsAfterSecond,
      `Hysteresis broken: second tick fired ${emailsAfterSecond} email(s) while still above threshold. ` +
        `dispatchAlerts() must suppress both transports until spread drops below threshold and re-arms.`
    ).toBe(0);

    expect(
      pushAfterSecond,
      `Hysteresis broken: second tick fired ${pushAfterSecond} push notification(s) while still above threshold. ` +
        `The web-push transport must respect the same hysteresis state as the email transport.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WP5 — DELETE /api/me/push-subscriptions removes a subscription
// ---------------------------------------------------------------------------

describe("WP5 — DELETE /api/me/push-subscriptions removes a subscription", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("wp5");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("DELETE /api/me/push-subscriptions removes the subscription by endpoint", async () => {
    insertPushSubscription(sqlite, FIXTURE_USER_WITH_KEY.id, FIXTURE_PUSH_SUBSCRIPTION);

    const sessionToken = process.env.FIXTURE_SESSION_TOKEN ??
      "fixture-session-token-do-not-use-in-prod";

    const res = await fetch("http://localhost:3000/api/me/push-subscriptions", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `next-auth.session-token=${sessionToken}`,
      },
      body: JSON.stringify({ endpoint: FIXTURE_PUSH_SUBSCRIPTION.endpoint }),
    });

    expect(
      res.status,
      `DELETE /api/me/push-subscriptions returned ${res.status}. Expected 200 or 204. ` +
        `Create DELETE support in app/api/me/push-subscriptions/route.ts.`
    ).toSatisfy((s: number) => s === 200 || s === 204);

    const row = sqlite
      .prepare(
        `SELECT * FROM ${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE} WHERE endpoint = ?`
      )
      .get(FIXTURE_PUSH_SUBSCRIPTION.endpoint);

    expect(
      row,
      `Subscription still present in push_subscriptions after DELETE. ` +
        `The DELETE handler must remove the row matching the given endpoint.`
    ).toBeUndefined();
  });

  it("after DELETE, no push notification is sent on threshold cross", async () => {
    // Ensure no subscriptions remain for this user
    sqlite
      .prepare(
        `DELETE FROM ${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE} WHERE user_id = ?`
      )
      .run(FIXTURE_USER_WITH_KEY.id);

    clearInbox();
    clearPushInbox();

    const Q = FIXTURE_QUESTIONS[0];
    const NOW = Date.now();
    seedSpreadSnapshot(sqlite, Q.id, 0.04, NOW);

    await invokeAlertDispatch(dbPath, NOW);

    const sent = getPushSentTo();
    expect(
      sent.length,
      `Expected 0 push notifications after subscription removal, got ${sent.length}. ` +
        `dispatchAlerts() must not send push notifications when push_subscriptions is empty.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WP6 — No web-push when user has no subscriptions (email-only fallback)
// ---------------------------------------------------------------------------

describe("WP6 — Email-only fallback when no push subscriptions are registered", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;
  const NOW = Date.now();
  const Q = FIXTURE_QUESTIONS[0];

  beforeAll(() => {
    dbPath = makeTempDbPath("wp6");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  beforeEach(() => {
    clearInbox();
    clearPushInbox();
  });

  it("threshold cross with no subscriptions fires email but NOT push", async () => {
    // Verify no subscriptions exist for this user
    const count = (
      sqlite
        .prepare(
          `SELECT COUNT(*) as n FROM ${EXPECTED_PUSH_SUBSCRIPTIONS_TABLE} WHERE user_id = ?`
        )
        .get(FIXTURE_USER_WITH_KEY.id) as { n: number }
    ).n;

    // If table doesn't exist, the query above throws → test fails with schema error (correct)
    expect(count, "Pre-condition: no subscriptions should be seeded for this test").toBe(0);

    seedSpreadSnapshot(sqlite, Q.id, 0.04, NOW);
    await invokeAlertDispatch(dbPath, NOW);

    expect(getInbox().length, "Email should be sent even without push subscriptions").toBe(1);
    expect(
      getPushSentTo().length,
      `sendNotification() was called ${getPushSentTo().length} time(s) despite no subscriptions. ` +
        `dispatchAlerts() must skip push when push_subscriptions is empty for the user.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WP7 — Multiple subscriptions: all active subscriptions receive the notification
// ---------------------------------------------------------------------------

describe("WP7 — All active subscriptions receive the notification", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;
  const NOW = Date.now();
  const Q = FIXTURE_QUESTIONS[0];

  beforeAll(() => {
    dbPath = makeTempDbPath("wp7");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  beforeEach(() => {
    clearInbox();
    clearPushInbox();
  });

  it("two subscriptions: both receive a push notification on threshold cross", async () => {
    insertPushSubscription(sqlite, FIXTURE_USER_WITH_KEY.id, FIXTURE_PUSH_SUBSCRIPTION);
    insertPushSubscription(sqlite, FIXTURE_USER_WITH_KEY.id, FIXTURE_PUSH_SUBSCRIPTION_2);

    seedSpreadSnapshot(sqlite, Q.id, 0.04, NOW);
    await invokeAlertDispatch(dbPath, NOW);

    const sent = getPushSentTo();
    expect(
      sent.length,
      `Expected 2 push notifications (one per subscription), got ${sent.length}. ` +
        `dispatchAlerts() must fan out to ALL active subscriptions for the user, not just one.`
    ).toBe(2);

    const endpoints = sent.map((s) => s.endpoint).sort();
    expect(endpoints).toContain(FIXTURE_PUSH_SUBSCRIPTION.endpoint);
    expect(endpoints).toContain(FIXTURE_PUSH_SUBSCRIPTION_2.endpoint);
  });
});
