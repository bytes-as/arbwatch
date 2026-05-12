/**
 * POST /api/watched/:id/rematch
 *
 * Two modes:
 *   - Body { platform }  → re-search only that platform and upsert its match.
 *   - Body {}            → find which platforms are currently unmatched, search
 *                          only those, and upsert new matches. Never touches or
 *                          removes existing matches.
 *
 * Auth-gated — scoped to the requesting user only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../../../db/client";
import { sessions } from "../../../../../db/tables";
import { eq, and, gt } from "drizzle-orm";
import { searchPlatforms } from "../../../../../lib/marketSearch";
import type { Platform } from "../../../../../lib/marketSearch";
import { randomUUID } from "node:crypto";

const ALL_SEARCHABLE_PLATFORMS: Platform[] = ["kalshi", "manifold", "polymarket", "robinhood"];

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function resolveSession(req: NextRequest): Promise<{ userId: string } | null> {
  const token =
    req.cookies.get(SESSION_COOKIE_NAME)?.value ??
    req.cookies.get("next-auth.session-token")?.value ??
    req.cookies.get("authjs.session-token")?.value;
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, token), gt(sessions.expires, now)));
  return row ? { userId: row.userId } : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const questionRows = await rawQuery<{ id: string; query_text: string }>`SELECT id, query_text FROM watched_questions WHERE id = ${id} AND user_id = ${session.userId}`;
  const question = questionRows[0];

  if (!question) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const targetPlatform = typeof body.platform === "string" ? body.platform as Platform : null;

  // Build a short keyword fallback from the query_text (first 4 words) so that
  // long market titles still hit the right results when the full title doesn't match.
  const shortQuery = question.query_text
    .replace(/[?!.,]/g, "")
    .split(/\s+/)
    .slice(0, 4)
    .join(" ");

  // Determine which platforms to search
  let platformsToSearch: Platform[];
  if (targetPlatform) {
    // Per-platform re-match: search only that one platform
    if (!ALL_SEARCHABLE_PLATFORMS.includes(targetPlatform)) {
      return NextResponse.json({ error: "Platform not searchable" }, { status: 400 });
    }
    platformsToSearch = [targetPlatform];
  } else {
    // Global fill: only search for platforms that have NO match yet
    const existing = await rawQuery<{ platform: Platform }>`SELECT platform FROM question_matches WHERE question_id = ${id}`;
    const matchedPlatforms = new Set(existing.map((r) => r.platform));
    platformsToSearch = ALL_SEARCHABLE_PLATFORMS.filter((p) => !matchedPlatforms.has(p));

    if (platformsToSearch.length === 0) {
      // All platforms already matched — return current matches unchanged
      const current = await rawQuery<{ platform: Platform; market_id: string; market_url: string | null; market_title: string | null; implied_yes_prob: number | null; close_date: string | null }>`SELECT platform, market_id, market_url, market_title, implied_yes_prob, close_date
           FROM question_matches WHERE question_id = ${id}`;
      return NextResponse.json({ matches: current, message: "All platforms already matched" });
    }
  }

  // Search with both the full query_text and a short keyword fallback,
  // then merge. Long titles often don't match; short keywords often do.
  const [fullResults, shortResults] = await Promise.all([
    searchPlatforms(session.userId, question.query_text, platformsToSearch),
    shortQuery !== question.query_text.replace(/[?!.,]/g, "")
      ? searchPlatforms(session.userId, shortQuery, platformsToSearch)
      : Promise.resolve([] as Awaited<ReturnType<typeof searchPlatforms>>),
  ]);
  const searchResults = [...fullResults, ...shortResults];

  // Deduplicate by platform — first result per platform wins
  const seenPlatforms = new Set<string>();
  const deduped = searchResults.filter((r) => {
    if (seenPlatforms.has(r.platform)) return false;
    seenPlatforms.add(r.platform);
    return true;
  });

  const now = Date.now();

  for (const r of deduped) {
    const rid = randomUUID();
    await rawQuery`INSERT INTO question_matches (id, question_id, platform, market_id, market_url, market_title, implied_yes_prob, last_seen_at)
    VALUES (${rid}, ${id}, ${r.platform}, ${r.market_id}, ${r.market_url}, ${r.market_title}, ${r.implied_yes_prob}, ${now})
    ON CONFLICT(question_id, platform) DO UPDATE SET
      market_id = excluded.market_id,
      market_url = excluded.market_url,
      market_title = excluded.market_title,
      implied_yes_prob = excluded.implied_yes_prob,
      last_seen_at = excluded.last_seen_at,
      close_date = NULL`;
  }

  // Return all current matches (not just the newly added ones)
  const matches = await rawQuery<{
    platform: Platform;
    market_id: string;
    market_url: string | null;
    market_title: string | null;
    implied_yes_prob: number | null;
    close_date: string | null;
  }>`SELECT platform, market_id, market_url, market_title, implied_yes_prob, close_date
       FROM question_matches WHERE question_id = ${id}`;

  return NextResponse.json({ matches });
}
