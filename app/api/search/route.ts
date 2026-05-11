/**
 * app/api/search/route.ts
 *
 * GET /api/search?q=<text>
 *
 * Fans out the query to all 4 prediction market platforms in parallel and
 * returns the top results from each. Auth-gated — uses the caller's Anakin key.
 *
 * Response: { results: SearchResult[] }
 * Each result has platform, market_id, market_title, market_url, implied_yes_prob.
 * Up to 10 results per platform; Kalshi results are less relevant (no text search).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../db/client";
import { sessions } from "../../../db/schema";
import { eq, and, gt } from "drizzle-orm";
import { WireError } from "../../../lib/wire/errors";
import { searchAllPlatforms } from "../../../lib/marketSearch";

export type { Platform, SearchResult } from "../../../lib/marketSearch";

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

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  // Use shared searchAllPlatforms — it fans out in parallel and merges results
  let results;
  try {
    results = await searchAllPlatforms(session.userId, q);
  } catch (err) {
    if (err instanceof WireError && err.class === "key-missing") {
      return NextResponse.json({ error: "key-missing", results: [] }, { status: 403 });
    }
    throw err;
  }

  return NextResponse.json({ results });
}
