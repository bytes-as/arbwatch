/**
 * POST /api/test-reset
 *
 * Development-only endpoint. Resets the fixture user's watched questions to
 * the 3-question baseline defined in tests/seeds/queries.yaml.
 *
 * Used by the Playwright seed-reporter to restore the DB between tests that
 * add questions, without disrupting the server's live SQLite connection.
 *
 * Returns 403 in production. Returns 204 on success.
 */

import { NextResponse } from "next/server";
import { sqlite } from "../../../db/client";

const FIXTURE_USER_ID = "00000000-0000-0000-0000-000000000001";

const SEED_QUESTION_IDS = [
  "10000000-0000-0000-0000-000000000001",
  "10000000-0000-0000-0000-000000000002",
  "10000000-0000-0000-0000-000000000003",
];

const SEED_QUESTIONS = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    query_text: "Will the Fed raise interest rates in 2026?",
    user_id: FIXTURE_USER_ID,
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    query_text: "Will the US enter a recession by end of 2026?",
    user_id: FIXTURE_USER_ID,
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    query_text: "Will a major AI lab release a model surpassing GPT-5 in 2026?",
    user_id: FIXTURE_USER_ID,
  },
];

export async function POST(): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const idList = SEED_QUESTION_IDS.map((id) => `'${id}'`).join(", ");

  sqlite
    .prepare(
      `DELETE FROM watched_questions WHERE user_id = ? AND id NOT IN (${idList})`
    )
    .run(FIXTURE_USER_ID);

  // Remove any spread_history rows whose parent question no longer exists
  // (SQLite FK cascades only fire when foreign_keys=ON, so we clean up explicitly)
  sqlite
    .prepare(
      `DELETE FROM spread_history WHERE question_id NOT IN (SELECT id FROM watched_questions)`
    )
    .run();

  const insertQ = sqlite.prepare(
    `INSERT INTO watched_questions (id, user_id, query_text, created_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(id) DO NOTHING`
  );

  for (const q of SEED_QUESTIONS) {
    insertQ.run(q.id, q.user_id, q.query_text);
  }

  return new NextResponse(null, { status: 204 });
}
