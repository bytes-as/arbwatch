// Unified table re-export: PG tables for Neon, SQLite tables for local dev.
// All app code imports from here; never import directly from db/schema or db/schema.pg.
//
// TypeScript sees the SQLite schema types (matching the SQLite-typed db client).
// At runtime, the correct module is loaded based on DATABASE_URL.
import type * as sqliteSchema from "./schema";

const isNeon = (process.env.DATABASE_URL ?? "").startsWith("postgres");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _s = (
  isNeon ? require("./schema.pg") : require("./schema")
) as typeof sqliteSchema;

export const users = _s.users;
export const accounts = _s.accounts;
export const sessions = _s.sessions;
export const verificationTokens = _s.verificationTokens;
export const watchedQuestions = _s.watchedQuestions;
export const questionMatches = _s.questionMatches;
export const spreadSnapshots = _s.spreadSnapshots;
export const alerts = _s.alerts;
export const spreadHistory = _s.spreadHistory;
export const pushSubscriptions = _s.pushSubscriptions;
