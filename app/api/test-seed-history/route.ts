/**
 * POST /api/test-seed-history
 *
 * Test-only endpoint. Returns 404 when ENABLE_TEST_ROUTES !== "true".
 *
 * Accepts:
 *   { history: [{ question_id, spread, days_ago }] }
 *
 * Inserts spread_history rows with computed_at = now - days_ago * 86400.
 * Returns: { ok: true, seeded: N }
 */

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "../../../db/client";
import { randomUUID } from "node:crypto";

interface HistoryEntry {
  question_id: string;
  spread: number | null;
  days_ago: number;
}

interface SeedPayload {
  history: HistoryEntry[];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.ENABLE_TEST_ROUTES !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as SeedPayload | null;

  if (!body || !Array.isArray(body.history)) {
    return NextResponse.json(
      { error: "Invalid payload: expected { history: [...] }" },
      { status: 400 }
    );
  }

  const insertHistory = sqlite.prepare(
    `INSERT INTO spread_history (id, question_id, spread, computed_at)
     VALUES (?, ?, ?, ?)`
  );

  const nowSec = Math.floor(Date.now() / 1000);

  const seedTx = sqlite.transaction((entries: HistoryEntry[]) => {
    for (const entry of entries) {
      const computedAt = nowSec - entry.days_ago * 86_400;
      insertHistory.run(randomUUID(), entry.question_id, entry.spread, computedAt);
    }
  });

  seedTx(body.history);

  return NextResponse.json({ ok: true, seeded: body.history.length });
}
