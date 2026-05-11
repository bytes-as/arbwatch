import {
  sqliteTable,
  text,
  integer,
  blob,
  real,
  check,
  primaryKey,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    anakinKeyCt: blob("anakin_key_ct"),
    // Enum: ok | key-missing | key-invalid | quota-exhausted
    anakinKeyStatus: text("anakin_key_status", {
      enum: ["ok", "key-missing", "key-invalid", "quota-exhausted"],
    })
      .notNull()
      .default("key-missing"),
    anakinKeyStatusAt: integer("anakin_key_status_at", { mode: "timestamp" }),
  },
  (t) => [
    check(
      "anakin_key_status_check",
      sql`${t.anakinKeyStatus} IN ('ok', 'key-missing', 'key-invalid', 'quota-exhausted')`
    ),
  ]
);

// ---------------------------------------------------------------------------
// watched_questions
// ---------------------------------------------------------------------------

export const watchedQuestions = sqliteTable(
  "watched_questions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    queryText: text("query_text").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    threshold: real("threshold"),
    embedding: blob("embedding"),
  },
  (t) => [
    check(
      "watched_questions_threshold_check",
      sql`${t.threshold} IS NULL OR (${t.threshold} >= 0.005 AND ${t.threshold} <= 0.10)`
    ),
  ]
);

// ---------------------------------------------------------------------------
// question_matches
// ---------------------------------------------------------------------------

export const questionMatches = sqliteTable(
  "question_matches",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => watchedQuestions.id, { onDelete: "cascade" }),
    platform: text("platform", {
      enum: ["kalshi", "manifold", "polymarket", "robinhood"],
    }).notNull(),
    marketId: text("market_id").notNull(),
    marketUrl: text("market_url"),
    marketTitle: text("market_title"),
    impliedYesProb: real("implied_yes_prob"),
    lastSeenAt: integer("last_seen_at").notNull(),
    matchScore: real("match_score"),
  },
  (t) => [unique().on(t.questionId, t.platform)]
);

// ---------------------------------------------------------------------------
// spread_snapshots
// ---------------------------------------------------------------------------

export const spreadSnapshots = sqliteTable("spread_snapshots", {
  id: text("id").primaryKey(),
  questionId: text("question_id")
    .notNull()
    .references(() => watchedQuestions.id, { onDelete: "cascade" }),
  spread: real("spread"),
  lastUpdated: integer("last_updated", { mode: "timestamp" }).notNull(),
  computedAt: integer("computed_at", { mode: "timestamp" }).notNull(),
});

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => watchedQuestions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: text("state", { enum: ["armed", "fired"] }).notNull(),
    lastAlertedAt: integer("last_alerted_at"),
    lastAlertedSpread: real("last_alerted_spread"),
  },
  (t) => [
    unique().on(t.questionId, t.userId),
    check("alerts_state_check", sql`${t.state} IN ('armed', 'fired')`),
  ]
);

// ---------------------------------------------------------------------------
// spread_history
// ---------------------------------------------------------------------------

export const spreadHistory = sqliteTable("spread_history", {
  id: text("id").primaryKey(),
  questionId: text("question_id")
    .notNull()
    .references(() => watchedQuestions.id, { onDelete: "cascade" }),
  spread: real("spread"),
  computedAt: integer("computed_at").notNull(),
});

// ---------------------------------------------------------------------------
// push_subscriptions
// ---------------------------------------------------------------------------

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [unique().on(t.userId, t.endpoint)]
);

// ---------------------------------------------------------------------------
// NextAuth v5 adapter tables
// ---------------------------------------------------------------------------

export const accounts = sqliteTable("accounts", {
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("providerAccountId").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
});

export const sessions = sqliteTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
});

export const verificationTokens = sqliteTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })]
);
