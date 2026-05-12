/**
 * POST /api/explore  — start an explore job.
 *                      Fetches top open Kalshi markets, searches other platforms
 *                      for each one in parallel, returns spread opportunities.
 *                      Returns { jobId } immediately; process runs in background.
 *
 * GET  /api/explore?jobId=xxx — poll job status.
 *                      Returns { status } or { status: "completed", questions: [...] }
 *
 * Auth-gated — uses the requesting user's stored Anakin key.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "../../../db/client";
import { sessions } from "../../../db/tables";
import { eq, and, gt } from "drizzle-orm";
import { wireRequest } from "../../../lib/wire/client";
import { WireError } from "../../../lib/wire/errors";
import { searchPlatforms } from "../../../lib/marketSearch";
import type { Platform } from "../../../lib/marketSearch";

// ---------------------------------------------------------------------------
// In-memory job store (cleared on server restart — acceptable for this use case)
// ---------------------------------------------------------------------------

interface ExploreMatch {
  platform: Platform;
  market_id: string;
  market_url: string | null;
  market_title: string;
  implied_yes_prob: number | null;
}

export interface ExploreOpportunity {
  question_text: string;
  estimated_spread: number | null;
  matches: ExploreMatch[];
}

type JobState =
  | { status: "processing" }
  | { status: "failed"; error: string }
  | { status: "completed"; questions: ExploreOpportunity[] };

const jobs = new Map<string, JobState>();

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

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
// Kalshi market extraction from kl_events bulk response
// ---------------------------------------------------------------------------

interface KalshiMarket {
  market_id: string;
  title: string;
  yes_bid: number | null;
  yes_ask: number | null;
  last_price: number | null;
  volume: number | null;
}

function extractKalshiMarkets(payload: unknown): KalshiMarket[] {
  const p = payload as Record<string, unknown>;

  // Flat shape { markets: [...] } from query API
  if (Array.isArray(p.markets)) {
    return (p.markets as Array<Record<string, unknown>>).flatMap((m) => {
      const id = (m.market_id as string) ?? (m.ticker as string) ?? null;
      const title = (m.title as string) ?? null;
      if (!id || !title) return [];
      return [{
        market_id: id,
        title,
        yes_bid: typeof m.yes_bid === "number" ? m.yes_bid : null,
        yes_ask: typeof m.yes_ask === "number" ? m.yes_ask : null,
        last_price: typeof m.last_price === "number" ? m.last_price : null,
        volume: typeof m.volume === "number" ? m.volume : null,
      }];
    });
  }

  // Nested shape { events: [{ markets: [...] }] } from bulk API
  // One entry per EVENT (not per market) — multi-outcome events like "Who will be Pope?"
  // have many per-candidate markets; we want one search per event question.
  if (Array.isArray(p.events)) {
    const markets: KalshiMarket[] = [];
    for (const event of p.events as Array<Record<string, unknown>>) {
      const eventTitle = (event.title as string) ?? null;
      const eventTicker = (event.event_ticker as string) ?? null;
      const eventMarkets = Array.isArray(event.markets)
        ? (event.markets as Array<Record<string, unknown>>)
        : [];

      // For binary events (single YES/NO market), use that market's data directly
      // For multi-outcome events, use the event ticker + aggregate volume
      const isBinary = eventMarkets.length === 1;
      const representativeMarket = eventMarkets[0] ?? null;
      const id = isBinary
        ? ((representativeMarket?.ticker as string) ?? eventTicker)
        : eventTicker;
      const title = eventTitle;
      if (!id || !title) continue;

      // Sum volume across all markets in the event
      const totalVolume = eventMarkets.reduce((sum, m) => {
        return sum + (typeof m.volume === "number" ? m.volume : 0);
      }, 0);

      // For binary events use the single market's price; for multi-outcome skip (prob irrelevant)
      const yes_bid = isBinary && representativeMarket ? (typeof representativeMarket.yes_bid === "number" ? representativeMarket.yes_bid : null) : null;
      const yes_ask = isBinary && representativeMarket ? (typeof representativeMarket.yes_ask === "number" ? representativeMarket.yes_ask : null) : null;
      const last_price = isBinary && representativeMarket ? (typeof representativeMarket.last_price === "number" ? representativeMarket.last_price : null) : null;

      markets.push({
        market_id: id,
        title,
        yes_bid,
        yes_ask,
        last_price,
        volume: totalVolume > 0 ? totalVolume : null,
      });
    }
    return markets;
  }

  return [];
}

function kalshiProb(m: KalshiMarket): number | null {
  if (m.yes_bid !== null && m.yes_ask !== null) return (m.yes_bid + m.yes_ask) / 200;
  if (m.last_price !== null) return m.last_price / 100;
  return null;
}

// ---------------------------------------------------------------------------
// Core explore logic
// ---------------------------------------------------------------------------

async function runExplore(userId: string, jobId: string): Promise<void> {
  try {
    // Step 1: fetch top open Kalshi markets sorted by volume
    const kalshiPayload = await wireRequest(userId, "kl_events", {
      status: "open",
      with_nested_markets: true,
      limit: 100,
    });

    const allMarkets = extractKalshiMarkets(kalshiPayload);

    // Sort by volume descending, take top 10 for cross-platform search
    const topMarkets = allMarkets
      .filter((m) => m.title && m.title.length > 10)
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 10);

    if (topMarkets.length === 0) {
      jobs.set(jobId, { status: "completed", questions: [] });
      return;
    }

    // Step 2: for each Kalshi market, search manifold/polymarket/robinhood in parallel
    const OTHER_PLATFORMS: Platform[] = ["manifold", "polymarket", "robinhood"];

    const searchResults = await Promise.allSettled(
      topMarkets.map((km) =>
        searchPlatforms(userId, km.title, OTHER_PLATFORMS).then((results) => ({
          kalshi: km,
          others: results,
        }))
      )
    );

    // Step 3: build opportunities — include all top Kalshi markets; cross-platform matches
    // are best-effort (text search may not find counterparts for every market).
    // Sort: cross-platform spreads first, then single-platform Kalshi-only entries.
    const opportunities: ExploreOpportunity[] = [];

    for (const result of searchResults) {
      if (result.status === "rejected") continue;
      const { kalshi, others } = result.value;

      const kalshiProb_ = kalshiProb(kalshi);

      // Deduplicate other platforms — first result per platform wins
      const seenPlatforms = new Set<string>();
      const otherMatches: ExploreMatch[] = [];
      for (const r of others) {
        if (seenPlatforms.has(r.platform)) continue;
        seenPlatforms.add(r.platform);
        otherMatches.push({
          platform: r.platform,
          market_id: r.market_id,
          market_url: r.market_url,
          market_title: r.market_title,
          implied_yes_prob: r.implied_yes_prob,
        });
      }

      const allProbs: number[] = [];
      if (kalshiProb_ !== null) allProbs.push(kalshiProb_);
      for (const m of otherMatches) {
        if (m.implied_yes_prob !== null) allProbs.push(m.implied_yes_prob);
      }
      const estimatedSpread = allProbs.length >= 2
        ? Math.max(...allProbs) - Math.min(...allProbs)
        : null;

      const kalshiMatch: ExploreMatch = {
        platform: "kalshi",
        market_id: kalshi.market_id,
        market_url: `https://kalshi.com/markets/${kalshi.market_id}`,
        market_title: kalshi.title,
        implied_yes_prob: kalshiProb_,
      };

      opportunities.push({
        question_text: kalshi.title,
        estimated_spread: estimatedSpread,
        matches: [kalshiMatch, ...otherMatches],
      });
    }

    // Sort: opportunities with a real cross-platform spread first (desc), then Kalshi-only
    opportunities.sort((a, b) => {
      if (a.estimated_spread !== null && b.estimated_spread !== null) return b.estimated_spread - a.estimated_spread;
      if (a.estimated_spread !== null) return -1;
      if (b.estimated_spread !== null) return 1;
      return 0;
    });

    jobs.set(jobId, { status: "completed", questions: opportunities.slice(0, 10) });
  } catch (err) {
    const msg = err instanceof WireError ? err.class : "explore failed";
    jobs.set(jobId, { status: "failed", error: msg });
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobId = randomUUID();
  jobs.set(jobId, { status: "processing" });

  // Fire and forget — result stored in jobs map
  runExplore(session.userId, jobId).catch((err) => {
    console.error("[explore] unhandled error:", err);
    jobs.set(jobId, { status: "failed", error: "unexpected error" });
  });

  return NextResponse.json({ jobId });
}

export async function GET(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = jobs.get(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status === "completed") {
    return NextResponse.json({ status: "completed", questions: job.questions });
  }
  if (job.status === "failed") {
    return NextResponse.json({ status: "failed", error: job.error });
  }
  return NextResponse.json({ status: "processing" });
}
