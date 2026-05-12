/**
 * app/api/watched/route.ts
 *
 * GET  /api/watched  — list the authenticated user's watched questions
 * POST /api/watched  — add a watched question (5-cap enforced)
 *
 * Auth-gated via session cookie. userId is always derived from the session,
 * never from the request body (ADR-0001: no IDOR via user-supplied id).
 *
 * Validation:
 *   - query_text must be non-empty after trim
 *   - query_text must be ≤ 280 characters (MAX_QUERY_TEXT_LENGTH)
 *   - caller must have < 5 existing rows (5-cap; CAP_EXCEEDED_MESSAGE on rejection)
 *
 * created_at is stored as Unix milliseconds (integer) for sub-second ordering
 * precision. Using raw SQL insert bypasses Drizzle's mode:"timestamp" second
 * truncation, keeping it consistent with the test's insertWatchedQuestion helper
 * which also stores Date.now() (ms).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../db/client";
import { sessions, watchedQuestions } from "../../../db/tables";
import { eq, and, gt, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { matchQuestion, fetchFreshPrices } from "../../../lib/matching";
import { computeSpreadForQuestion } from "../../../lib/cron";
import { WireError } from "../../../lib/wire/errors";

interface PreMatch {
  platform: string;
  market_id: string;
  market_title: string | null;
  market_url: string | null;
  implied_yes_prob: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUERY_TEXT_LENGTH = 280;
const QUESTION_CAP = 5;
const CAP_EXCEEDED_MESSAGE =
  "You've reached the 5-question limit. Remove a question to add a new one.";

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function resolveSession(
  request: NextRequest
): Promise<{ userId: string } | null> {
  const sessionToken =
    request.cookies.get(SESSION_COOKIE_NAME)?.value ??
    request.cookies.get("next-auth.session-token")?.value ??
    request.cookies.get("authjs.session-token")?.value;

  if (!sessionToken) return null;

  const now = new Date();
  const [result] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  return result ? { userId: result.userId } : null;
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Use raw SQL to retrieve as-stored integer for created_at (ms or s depending
  // on insertion path) and order correctly regardless of encoding.
  const rows = await rawQuery<{
    id: string;
    query_text: string;
    created_at: number;
  }>`SELECT id, query_text, created_at FROM watched_questions
       WHERE user_id = ${session.userId}
       ORDER BY created_at DESC`;

  return NextResponse.json(rows);
}

// ---------------------------------------------------------------------------
// POST — add
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const raw = typeof body.query_text === "string" ? body.query_text : "";
  const trimmed = raw.trim();

  if (!trimmed) {
    return NextResponse.json(
      { error: "query_text is required and must not be empty." },
      { status: 400 }
    );
  }

  if (trimmed.length > MAX_QUERY_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `query_text must be at most ${MAX_QUERY_TEXT_LENGTH} characters.` },
      { status: 400 }
    );
  }

  // Optional pre-matched results from the live search UI (avoids re-running matching)
  const preMatches = Array.isArray(body.pre_matches)
    ? (body.pre_matches as PreMatch[])
    : null;

  const [countResult] = await db
    .select({ cnt: count() })
    .from(watchedQuestions)
    .where(eq(watchedQuestions.userId, session.userId));

  const existing = countResult?.cnt ?? 0;
  if (existing >= QUESTION_CAP) {
    return NextResponse.json({ error: CAP_EXCEEDED_MESSAGE }, { status: 400 });
  }

  const id = randomUUID();
  const createdAt = Date.now();

  await rawQuery`INSERT INTO watched_questions (id, user_id, query_text, created_at) VALUES (${id}, ${session.userId}, ${trimmed}, ${createdAt})`;

  let matchingStatus: string | undefined;

  let initialSpread: number | null = null;

  if (preMatches && preMatches.length > 0) {
    // Insert pre-matched rows directly — no Wire call needed
    const now = Date.now();
    for (const m of preMatches) {
      if (m.platform && m.market_id) {
        const matchId = randomUUID();
        const mUrl = m.market_url ?? null;
        const mTitle = m.market_title ?? null;
        const mProb = m.implied_yes_prob ?? null;
        await rawQuery`INSERT INTO question_matches
           (id, question_id, platform, market_id, market_url, market_title, implied_yes_prob, last_seen_at)
         VALUES (${matchId}, ${id}, ${m.platform}, ${m.market_id}, ${mUrl}, ${mTitle}, ${mProb}, ${now})
         ON CONFLICT (question_id, platform) DO UPDATE SET
           market_id = excluded.market_id,
           market_url = excluded.market_url,
           market_title = excluded.market_title,
           implied_yes_prob = excluded.implied_yes_prob,
           last_seen_at = excluded.last_seen_at`;
      }
    }

    // Immediately fetch fresh prices from Wire and compute initial spread.
    // Falls back to search-result prices if Wire calls fail.
    try {
      const freshProbs = await fetchFreshPrices(session.userId, preMatches);
      const definedFresh = freshProbs.filter((p): p is number => p !== null);
      const probs = definedFresh.length >= 2 ? definedFresh
        : preMatches.map((m) => m.implied_yes_prob).filter((p): p is number => p !== null);

      if (probs.length >= 2) {
        initialSpread = computeSpreadForQuestion(probs);
        const nowSec = Math.floor(now / 1000);
        const ssId = randomUUID();
        await rawQuery`INSERT INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
           VALUES (${ssId}, ${id}, ${initialSpread}, ${nowSec}, ${nowSec})
           ON CONFLICT (question_id) DO UPDATE SET
             spread = excluded.spread,
             last_updated = excluded.last_updated,
             computed_at = excluded.computed_at`;
        const shId = randomUUID();
        await rawQuery`INSERT INTO spread_history (id, question_id, spread, computed_at) VALUES (${shId}, ${id}, ${initialSpread}, ${nowSec})`;

        // Update implied_yes_prob in question_matches with fresh prices
        for (let i = 0; i < preMatches.length && i < freshProbs.length; i++) {
          if (freshProbs[i] !== null) {
            const fp = freshProbs[i];
            const platform = preMatches[i].platform;
            await rawQuery`UPDATE question_matches SET implied_yes_prob = ${fp} WHERE question_id = ${id} AND platform = ${platform}`;
          }
        }
      } else if (probs.length === 1) {
        // 1 platform: write null spread so cron knows it was attempted
        const nowSec = Math.floor(now / 1000);
        const ssId = randomUUID();
        await rawQuery`INSERT INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
           VALUES (${ssId}, ${id}, ${null}, ${nowSec}, ${nowSec})
           ON CONFLICT (question_id) DO UPDATE SET
             spread = NULL,
             last_updated = excluded.last_updated,
             computed_at = excluded.computed_at`;
      }
    } catch {
      // Spread computation is best-effort — cron will pick it up
    }
  } else {
    // Fall back to fuzzy matching via Wire
    try {
      await matchQuestion(session.userId, id, trimmed);
    } catch (err) {
      if (err instanceof WireError) {
        if (
          err.class === "key-missing" ||
          err.class === "key-invalid" ||
          err.class === "quota-exhausted"
        ) {
          matchingStatus = `skipped:${err.class}`;
        } else {
          console.warn("matchQuestion transient error:", err.class);
        }
      } else {
        console.warn("matchQuestion unexpected error:", err);
      }
    }
  }

  // Return the newly created question including any matches so the client can
  // update local state immediately without waiting for a router.refresh() round-trip.
  const freshMatches = await rawQuery<{
    platform: string;
    market_id: string;
    market_url: string | null;
    market_title: string | null;
    implied_yes_prob: number | null;
    close_date: string | null;
  }>`SELECT platform, market_id, market_url, market_title, implied_yes_prob, close_date
       FROM question_matches WHERE question_id = ${id}`;

  const response: Record<string, unknown> = {
    id,
    query_text: trimmed,
    created_at: createdAt,
    spread: initialSpread,
    matches: freshMatches,
  };
  if (matchingStatus) {
    response.matching_status = matchingStatus;
  }

  return NextResponse.json(response);
}
