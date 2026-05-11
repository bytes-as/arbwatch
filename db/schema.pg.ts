import {
  pgTable,
  text,
  integer,
  bigint,
  real,
  timestamp,
  check,
  primaryKey,
  unique,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// bytea custom type that round-trips Buffer <-> hex string from Neon HTTP
const bytea = customType<{ data: Buffer; driverData: string }>({
  dataType() {
    return "bytea";
  },
  toDriver(val: Buffer) {
    return "\\x" + val.toString("hex");
  },
  fromDriver(val: unknown) {
    if (Buffer.isBuffer(val)) return val;
    if (val instanceof Uint8Array) return Buffer.from(val);
    const s = val as string;
    return Buffer.from(s.startsWith("\\x") ? s.slice(2) : s, "hex");
  },
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("email_verified", { mode: "date" }),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    anakinKeyCt: bytea("anakin_key_ct"),
    anakinKeyStatus: text("anakin_key_status", {
      enum: ["ok", "key-missing", "key-invalid", "quota-exhausted"],
    })
      .notNull()
      .default("key-missing"),
    anakinKeyStatusAt: bigint("anakin_key_status_at", { mode: "number" }),
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

export const watchedQuestions = pgTable(
  "watched_questions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    queryText: text("query_text").notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    threshold: real("threshold"),
    embedding: bytea("embedding"),
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

export const questionMatches = pgTable(
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
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    matchScore: real("match_score"),
    closeDate: text("close_date"),
  },
  (t) => [unique().on(t.questionId, t.platform)]
);

// ---------------------------------------------------------------------------
// spread_snapshots
// ---------------------------------------------------------------------------

export const spreadSnapshots = pgTable("spread_snapshots", {
  id: text("id").primaryKey(),
  questionId: text("question_id")
    .notNull()
    .references(() => watchedQuestions.id, { onDelete: "cascade" }),
  spread: real("spread"),
  lastUpdated: integer("last_updated").notNull(),
  computedAt: integer("computed_at").notNull(),
});

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

export const alerts = pgTable(
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

export const spreadHistory = pgTable("spread_history", {
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

export const pushSubscriptions = pgTable(
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

export const accounts = pgTable("accounts", {
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

export const sessions = pgTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })]
);
