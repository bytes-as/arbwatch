/**
 * POST /api/test-seed-spreads
 *
 * Test-only endpoint. Returns 404 when ENABLE_TEST_ROUTES !== "true".
 *
 * Accepts a JSON body:
 * {
 *   questions: Array<{
 *     id: string,
 *     query_text: string,
 *     user_id: string,
 *     spread: number | null,
 *     last_updated_offset_minutes: number,
 *     platforms: Record<"kalshi"|"manifold"|"polymarket"|"robinhood", {
 *       matched: boolean,
 *       market_url: string | null,
 *       implied_yes_prob: number | null,
 *     }>
 *   }>
 * }
 *
 * Writes watched_questions, question_matches, and spread_snapshots for the
 * specified user_id directly into the SQLite DB. Existing rows for the same
 * question_id are replaced.
 */

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "../../../db/client";
import { randomUUID } from "node:crypto";

type PlatformKey = "kalshi" | "manifold" | "polymarket" | "robinhood";

interface PlatformEntry {
  matched: boolean;
  market_url: string | null;
  implied_yes_prob: number | null;
}

interface SeedQuestion {
  id: string;
  query_text: string;
  user_id: string;
  spread: number | null;
  last_updated_offset_minutes: number;
  platforms: Record<PlatformKey, PlatformEntry>;
}

interface SeedPayload {
  questions: SeedQuestion[];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.ENABLE_TEST_ROUTES !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as SeedPayload | null;

  if (!body || !Array.isArray(body.questions)) {
    return NextResponse.json(
      { error: "Invalid payload: expected { questions: [...] }" },
      { status: 400 }
    );
  }

  const now = Date.now();

  const insertQuestion = sqlite.prepare(`
    INSERT INTO watched_questions (id, user_id, query_text, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET query_text = excluded.query_text
  `);

  const deleteMatches = sqlite.prepare(
    `DELETE FROM question_matches WHERE question_id = ?`
  );

  const insertMatch = sqlite.prepare(`
    INSERT INTO question_matches (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_id, platform) DO UPDATE SET
      market_url = excluded.market_url,
      implied_yes_prob = excluded.implied_yes_prob,
      last_seen_at = excluded.last_seen_at
  `);

  const deleteSnapshot = sqlite.prepare(
    `DELETE FROM spread_snapshots WHERE question_id = ?`
  );

  const insertSnapshot = sqlite.prepare(`
    INSERT INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const seedAll = sqlite.transaction((questions: SeedQuestion[]) => {
    for (const q of questions) {
      insertQuestion.run(q.id, q.user_id, q.query_text, now);

      deleteMatches.run(q.id);

      const platforms: PlatformKey[] = ["kalshi", "manifold", "polymarket", "robinhood"];
      for (const platform of platforms) {
        const entry = q.platforms[platform];
        if (entry.matched) {
          insertMatch.run(
            randomUUID(),
            q.id,
            platform,
            `${platform}-${q.id}`,
            entry.market_url,
            entry.implied_yes_prob,
            now
          );
        }
      }

      deleteSnapshot.run(q.id);

      const lastUpdatedMs = now - q.last_updated_offset_minutes * 60_000;
      insertSnapshot.run(
        randomUUID(),
        q.id,
        q.spread,
        lastUpdatedMs,
        now
      );
    }
  });

  seedAll(body.questions);

  return NextResponse.json({ ok: true, seeded: body.questions.length });
}
