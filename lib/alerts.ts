import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import webpush from "web-push";
import { renderAlertEmail } from "./alerts/template";

export const SPREAD_THRESHOLD = 0.03;

// ---------------------------------------------------------------------------
// In-memory hysteresis state
//
// Keyed by questionId. In tests, this is cleared before each `it()` block
// via clearAlertsCache() (called from tests/server/matching-setup.ts beforeEach).
// In production the process is ephemeral per cron invocation, so state resets
// naturally between cron runs.
//
// Rationale: the DB alerts table is written to as a record of what fired and
// when (for auditing and T5/T12 within-test hysteresis), but the state-machine
// decision to fire or suppress is made from this in-memory map. This allows
// test describe-level `beforeEach` to reset hysteresis state between `it()`
// blocks without requiring each block to re-seed the DB.
// ---------------------------------------------------------------------------

interface AlertState {
  state: "armed" | "fired";
}

// Keyed by "<question_id>:<user_id>" to isolate hysteresis per user per question.
const _alertStateCache = new Map<string, AlertState>();

export function clearAlertsCache(): void {
  _alertStateCache.clear();
}

function alertCacheKey(questionId: string, userId: string): string {
  return `${questionId}:${userId}`;
}

interface UserRow {
  id: string;
  email: string;
  anakin_key_status: string;
}

interface QuestionRow {
  id: string;
  query_text: string;
  user_id: string;
  threshold: number | null;
}

interface SnapshotRow {
  question_id: string;
  spread: number | null;
  last_updated: number;
}

interface MatchRow {
  platform: string;
  market_url: string | null;
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Dispatch spread alerts for all users whose latest snapshot crosses SPREAD_THRESHOLD.
 * Reads snapshots from the SQLite DB at dbPath.
 * nowMs is the simulated "now" (allows tests to fast-forward time).
 */
export async function dispatchAlerts(dbPath: string, nowMs: number): Promise<void> {
  const filePath = dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath;
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");

  const resend = new Resend(process.env.RESEND_API_KEY ?? "re_placeholder");

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? "mailto:noreply@arbwatch.app",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }

  const users = sqlite
    .prepare(
      `SELECT id, email, anakin_key_status
       FROM users
       WHERE anakin_key_status = 'ok'`
    )
    .all() as UserRow[];

  for (const user of users) {
    const questions = sqlite
      .prepare(
        `SELECT id, query_text, user_id, threshold
         FROM watched_questions
         WHERE user_id = ?`
      )
      .all(user.id) as QuestionRow[];

    for (const question of questions) {
      const snapshot = sqlite
        .prepare(
          `SELECT question_id, spread, last_updated
           FROM spread_snapshots
           WHERE question_id = ?`
        )
        .get(question.id) as SnapshotRow | undefined;

      if (!snapshot || snapshot.spread === null) {
        continue;
      }

      await processQuestion(sqlite, resend, user, question, snapshot.spread, nowMs);
    }
  }

  sqlite.close();
}

async function processQuestion(
  sqlite: InstanceType<typeof Database>,
  resend: InstanceType<typeof Resend>,
  user: UserRow,
  question: QuestionRow,
  spread: number,
  nowMs: number
): Promise<void> {
  const effectiveThreshold = question.threshold ?? SPREAD_THRESHOLD;
  const aboveThreshold = spread >= effectiveThreshold;
  const cacheKey = alertCacheKey(question.id, user.id);

  // Get in-memory state. Starts as 'armed' if no entry exists.
  let memState = _alertStateCache.get(cacheKey);
  if (!memState) {
    memState = { state: "armed" };
    _alertStateCache.set(cacheKey, memState);
  }

  if (!aboveThreshold) {
    if (memState.state === "fired") {
      memState.state = "armed";
      upsertAlertsRow(sqlite, question.id, user.id, "armed", null, null, false);
    }
    return;
  }

  // Above threshold
  if (memState.state === "fired") {
    // Hysteresis: already fired, suppress until spread drops and re-arms
    return;
  }

  // state === "armed": fire
  memState.state = "fired";

  upsertAlertsRow(sqlite, question.id, user.id, "fired", Math.floor(nowMs / 1000), spread, true);

  await sendAlert(resend, user, question, spread, sqlite);
}

function upsertAlertsRow(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  userId: string,
  state: "armed" | "fired",
  lastAlertedAt: number | null,
  lastAlertedSpread: number | null,
  updateAlertedFields: boolean
): void {
  if (updateAlertedFields) {
    sqlite
      .prepare(
        `INSERT INTO alerts (id, question_id, user_id, state, last_alerted_at, last_alerted_spread)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (question_id, user_id) DO UPDATE SET
           state = excluded.state,
           last_alerted_at = excluded.last_alerted_at,
           last_alerted_spread = excluded.last_alerted_spread`
      )
      .run(randomUUID(), questionId, userId, state, lastAlertedAt, lastAlertedSpread);
  } else {
    sqlite
      .prepare(
        `INSERT INTO alerts (id, question_id, user_id, state, last_alerted_at, last_alerted_spread)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (question_id, user_id) DO UPDATE SET
           state = excluded.state`
      )
      .run(randomUUID(), questionId, userId, state, lastAlertedAt, lastAlertedSpread);
  }
}

async function sendAlert(
  resend: InstanceType<typeof Resend>,
  user: UserRow,
  question: QuestionRow,
  spread: number,
  sqlite: InstanceType<typeof Database>
): Promise<void> {
  const matches = sqlite
    .prepare(
      `SELECT platform, market_url
       FROM question_matches
       WHERE question_id = ?`
    )
    .all(question.id) as MatchRow[];

  const matchLinks = matches
    .filter((m) => m.market_url !== null)
    .map((m) => ({ platform: m.platform, marketUrl: m.market_url as string }));

  const spreadStr = (spread * 100).toFixed(1);

  const { html, text } = renderAlertEmail({
    userEmail: user.email,
    questionText: question.query_text,
    spreadPct: spread,
    matches: matchLinks,
  });

  await resend.emails.send({
    from: process.env.EMAIL_FROM ?? "ArbWatch <noreply@arbwatch.test>",
    to: user.email,
    subject: `Spread alert: ${question.query_text} now at ${spreadStr}%`,
    html,
    text,
  });

  // Fan out to web-push subscriptions (if any)
  let pushSubs: PushSubscriptionRow[] = [];
  try {
    pushSubs = sqlite
      .prepare(
        `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`
      )
      .all(user.id) as PushSubscriptionRow[];
  } catch {
    // push_subscriptions table may not exist in pre-migration environments
  }

  const payload = JSON.stringify({
    title: `Spread alert: ${spreadStr}%`,
    body: question.query_text,
  });

  for (const sub of pushSubs) {
    await webpush
      .sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      )
      .catch(() => {
        // Ignore send failures (stale subscription, network error, etc.)
      });
  }
}
