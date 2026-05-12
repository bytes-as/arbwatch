/**
 * POST /api/watched/:id/match
 * DELETE /api/watched/:id/match?platform=<platform>
 *
 * POST: Manually links a platform market to a watched question via a pasted URL.
 * DELETE: Removes the match for a specific platform from this question.
 *
 * Auth-gated — scoped to requesting user only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../../../db/client";
import { sessions } from "../../../../../db/tables";
import { eq, and, gt } from "drizzle-orm";
import { wireRequest } from "../../../../../lib/wire/client";
import {
  extractImpliedYesProb,
  extractMarketTitle,
  extractMarketUrl,
  extractCloseDate,
} from "../../../../../lib/wire/mapping";
import type { Platform } from "../../../../../lib/marketSearch";
import { randomUUID } from "node:crypto";

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

/** Extract a market identifier from a platform URL. Returns null if parsing fails. */
async function extractMarketIdentifier(
  userId: string,
  platform: Platform,
  url: string
): Promise<{ market_id: string; market_url: string } | null> {
  if (platform === "kalshi") {
    // kalshi.com/markets/KXETHD-25DEC31 → ticker
    const m = url.match(/\/markets\/([^/?#]+)/);
    if (!m) {
      // Maybe user just pasted the ticker directly
      const cleaned = url.trim().replace(/^https?:\/\/.*\/markets\//, "");
      if (/^[A-Z0-9]+-[A-Z0-9]+$/i.test(cleaned)) {
        return { market_id: cleaned.toUpperCase(), market_url: `https://kalshi.com/markets/${cleaned.toUpperCase()}` };
      }
      return null;
    }
    const ticker = m[1];
    return { market_id: ticker, market_url: `https://kalshi.com/markets/${ticker}` };
  }

  if (platform === "manifold") {
    // manifold.markets/username/market-slug → last non-empty path segment
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) return null;
      const slug = segments[segments.length - 1];
      return { market_id: slug, market_url: `https://manifold.markets/${parsed.pathname.replace(/^\//, "")}` };
    } catch {
      return null;
    }
  }

  if (platform === "polymarket") {
    // polymarket.com/event/event-slug → search for UUID via pm_search_markets
    const m = url.match(/\/event\/([^/?#]+)/);
    if (!m) return null;
    const eventSlug = m[1];
    try {
      const payload = await wireRequest(userId, "pm_search_markets", { query: eventSlug, limit: 1 });
      const p = payload as Record<string, unknown>;
      const events = Array.isArray(p.events) ? (p.events as Array<Record<string, unknown>>) : [];
      if (events.length === 0) return null;
      const markets = Array.isArray(events[0].markets) ? (events[0].markets as Array<Record<string, unknown>>) : [];
      if (markets.length === 0) return null;
      const marketId = markets[0].id as string | undefined;
      if (!marketId) return null;
      return { market_id: marketId, market_url: `https://polymarket.com/event/${eventSlug}` };
    } catch {
      return null;
    }
  }

  if (platform === "robinhood") {
    // robinhood.com/us/en/prediction-markets/category/events/event-slug/ → UUID
    const m = url.match(/\/events\/([^/?#/]+)/);
    if (!m) return null;
    const eventSlug = m[1];
    try {
      const payload = await wireRequest(userId, "rh_get_markets", { search: eventSlug, limit: 1, live_only: false });
      const p = payload as Record<string, unknown>;
      const events = Array.isArray(p.events) ? (p.events as Array<Record<string, unknown>>) : [];
      if (events.length === 0) return null;
      const eventId = events[0].id as string | undefined;
      if (!eventId) return null;
      // Reconstruct URL from the pasted URL (preserve original path)
      const marketUrl = url.startsWith("http") ? url : `https://robinhood.com/us/en/prediction-markets/events/${eventSlug}/`;
      return { market_id: eventId, market_url: marketUrl };
    } catch {
      return null;
    }
  }

  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Verify question belongs to this user
  const questionRows = await rawQuery<{ id: string }>`SELECT id FROM watched_questions WHERE id = ${id} AND user_id = ${session.userId}`;
  const question = questionRows[0];

  if (!question) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: {
    platform: string;
    url?: string;
    market_id?: string;
    market_title?: string;
    implied_yes_prob?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { platform } = body;
  if (!platform) {
    return NextResponse.json({ error: "platform is required" }, { status: 400 });
  }
  if (!body.url && !body.market_id) {
    return NextResponse.json({ error: "url or market_id is required" }, { status: 400 });
  }

  // If market_id is provided directly (e.g. from inline search results), skip URL parsing
  let market_id: string;
  let market_url: string | null;

  if (body.market_id) {
    market_id = body.market_id;
    market_url = body.url || null;
  } else {
    const parsed = await extractMarketIdentifier(session.userId, platform as Platform, body.url!);
    if (!parsed) {
      return NextResponse.json({ error: "Could not parse market ID from URL" }, { status: 400 });
    }
    market_id = parsed.market_id;
    market_url = parsed.market_url;
  }

  // Call Wire to validate and get fresh data
  const DETAIL_ACTION: Record<string, string> = {
    kalshi: "kl_market_detail",
    manifold: "mm_market_prob",
    polymarket: "pm_get_market",
    robinhood: "rh_get_event",
  };
  const DETAIL_PARAMS: Record<string, (id: string) => Record<string, unknown>> = {
    kalshi: (ticker) => ({ ticker }),
    manifold: (market_id) => ({ market_id }),
    polymarket: (market_id) => ({ market_id }),
    robinhood: (event_id) => ({ event_id }),
  };

  // Seed with pre-provided values from search results (used as fallback if Wire detail fails)
  let implied_yes_prob: number | null = body.implied_yes_prob ?? null;
  let market_title: string | null = body.market_title ?? null;
  let resolved_market_url: string | null = market_url;
  let close_date: string | null = null;

  try {
    const action = DETAIL_ACTION[platform];
    const detailParams = DETAIL_PARAMS[platform];
    if (action && detailParams) {
      const payload = await wireRequest(session.userId, action, detailParams(market_id));
      implied_yes_prob = extractImpliedYesProb(platform, payload) ?? implied_yes_prob;
      market_title = extractMarketTitle(platform as Platform, payload) ?? market_title;
      const extractedUrl = extractMarketUrl(platform as Platform, payload);
      if (extractedUrl) resolved_market_url = extractedUrl;
      close_date = extractCloseDate(platform, payload);
    }
  } catch {
    // Best-effort — use pre-provided data from search if Wire detail fails
  }

  // Upsert into question_matches
  const matchInsertId = randomUUID();
  const nowMs = Date.now();
  try {
    await rawQuery`INSERT INTO question_matches (id, question_id, platform, market_id, market_url, market_title, implied_yes_prob, last_seen_at, close_date)
        VALUES (${matchInsertId}, ${id}, ${platform}, ${market_id}, ${resolved_market_url}, ${market_title}, ${implied_yes_prob}, ${nowMs}, ${close_date})
        ON CONFLICT(question_id, platform) DO UPDATE SET
          market_id = excluded.market_id,
          market_url = excluded.market_url,
          market_title = COALESCE(excluded.market_title, market_title),
          implied_yes_prob = COALESCE(excluded.implied_yes_prob, implied_yes_prob),
          close_date = COALESCE(excluded.close_date, close_date)`;
  } catch (dbErr) {
    console.error("[match] DB upsert failed:", dbErr);
    // Retry without close_date in case the column doesn't exist in this DB version
    try {
      await rawQuery`INSERT INTO question_matches (id, question_id, platform, market_id, market_url, market_title, implied_yes_prob, last_seen_at)
          VALUES (${matchInsertId}, ${id}, ${platform}, ${market_id}, ${resolved_market_url}, ${market_title}, ${implied_yes_prob}, ${nowMs})
          ON CONFLICT(question_id, platform) DO UPDATE SET
            market_id = excluded.market_id,
            market_url = excluded.market_url,
            market_title = COALESCE(excluded.market_title, market_title),
            implied_yes_prob = COALESCE(excluded.implied_yes_prob, implied_yes_prob)`;
    } catch (retryErr) {
      console.error("[match] DB upsert retry also failed:", retryErr);
      return NextResponse.json({ error: "Failed to save match. Please try again." }, { status: 500 });
    }
  }

  const match = {
    platform: platform as Platform,
    market_id,
    market_url: resolved_market_url,
    market_title,
    implied_yes_prob,
    close_date,
  };

  return NextResponse.json({ match });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const platform = request.nextUrl.searchParams.get("platform");
  if (!platform) return NextResponse.json({ error: "platform query param required" }, { status: 400 });

  // Verify question belongs to this user before touching matches
  const questionRows = await rawQuery<{ id: string }>`SELECT id FROM watched_questions WHERE id = ${id} AND user_id = ${session.userId}`;
  if (!questionRows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await rawQuery`DELETE FROM question_matches WHERE question_id = ${id} AND platform = ${platform}`;

  return NextResponse.json({ ok: true });
}
