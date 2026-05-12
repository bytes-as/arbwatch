/**
 * lib/marketSearch.ts
 *
 * Shared search logic extracted from app/api/search/route.ts.
 * Fans out a text query to all supported prediction market platforms in parallel.
 *
 * Kalshi has no text-search API — kl_events returns all open events and we
 * filter client-side by token overlap against the query.
 */

import { wireRequest } from "./wire/client";
import { WireError } from "./wire/errors";

export type Platform = "kalshi" | "manifold" | "polymarket" | "robinhood";

export interface SearchResult {
  platform: Platform;
  market_id: string;
  market_title: string;
  market_url: string | null;
  implied_yes_prob: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

// ---------------------------------------------------------------------------
// Per-platform result extractors (copied from app/api/search/route.ts)
// ---------------------------------------------------------------------------

function extractManifoldResults(payload: unknown, _query?: string): SearchResult[] {
  const p = payload as Record<string, unknown>;
  return asArray(p.markets)
    .slice(0, 10)
    .flatMap((m) => {
      const id = m.id as string | undefined;
      const title = (m.question as string) ?? null;
      if (!id || !title) return [];
      const prob = typeof m.probability === "number" ? m.probability : null;
      return [{ platform: "manifold" as Platform, market_id: id, market_title: title, market_url: (m.url as string) ?? null, implied_yes_prob: prob }];
    });
}

function extractPolymarketResults(payload: unknown, _query?: string): SearchResult[] {
  const p = payload as Record<string, unknown>;
  const results: SearchResult[] = [];
  for (const event of asArray(p.events).slice(0, 10)) {
    const markets = asArray(event.markets);
    if (markets.length === 0) continue;
    // Take the first active, non-closed binary market in this event
    for (const market of markets) {
      if (market.active === false || market.closed === true) continue;
      const id = market.id as string | undefined;
      const title = (market.question as string) ?? (event.title as string) ?? null;
      if (!id || !title) continue;

      // pm_search_markets: prices at market level, outcomes is ["Yes","No"] string array
      const bid = typeof market.best_bid === "number" ? market.best_bid : null;
      const ask = typeof market.best_ask === "number" ? market.best_ask : null;
      const last = typeof market.last_trade_price === "number" ? market.last_trade_price : null;
      let prob: number | null = null;
      if (bid !== null && ask !== null && bid <= ask) {
        prob = (bid + ask) / 2;
      } else if (last !== null) {
        prob = last;
      } else {
        const outcomes = Array.isArray(market.outcomes) ? (market.outcomes as string[]) : [];
        const outcomePrices = Array.isArray(market.outcome_prices) ? (market.outcome_prices as number[]) : [];
        const yesIdx = outcomes.indexOf("Yes");
        if (yesIdx >= 0 && typeof outcomePrices[yesIdx] === "number") {
          prob = outcomePrices[yesIdx];
        }
      }

      // Use event-level slug — market slugs have appended numbers that break Polymarket URLs
      const eventSlug = (event.slug as string) ?? null;
      const market_url = eventSlug ? `https://polymarket.com/event/${eventSlug}` : null;

      results.push({ platform: "polymarket", market_id: id, market_title: title, market_url, implied_yes_prob: prob });
      break;
    }
  }
  return results;
}

function extractRobinhoodResults(payload: unknown, _query?: string): SearchResult[] {
  const p = payload as Record<string, unknown>;
  const events = asArray(p.events);
  console.log(`[rh search] raw events count: ${events.length}`);
  if (events.length > 0) {
    const sample = events[0];
    console.log(`[rh search] first event keys: ${Object.keys(sample).join(", ")}`);
    const contracts = asArray(sample.contracts);
    if (contracts.length > 0) {
      console.log(`[rh search] first contract keys: ${Object.keys(contracts[0]).join(", ")}`);
    }
  }

  const results: SearchResult[] = [];
  for (const ev of events.slice(0, 10)) {
    const id = ev.id as string | undefined;
    // Real API uses "name"; some fixture/legacy shapes use "title"
    const title = (ev.name as string) || (ev.title as string) || null;
    if (!id || !title) continue;
    const contracts = asArray(ev.contracts);
    if (results.length >= 10) break;
    let prob: number | null = null;
    // Try to find a YES-side contract first (new API: yes_bid/yes_ask; legacy: side==="yes")
    const yesContract = contracts.find((c) => (c.side as string) === "yes") ?? contracts[0] ?? null;
    if (yesContract) {
      const bid = yesContract.yes_bid as number | undefined;
      const ask = yesContract.yes_ask as number | undefined;
      const legacyBid = yesContract.bid_price as number | undefined;
      const legacyAsk = yesContract.ask_price as number | undefined;
      if (typeof bid === "number" && typeof ask === "number") {
        prob = (bid + ask) / 2;
      } else if (typeof legacyBid === "number" && typeof legacyAsk === "number") {
        prob = (legacyBid + legacyAsk) / 2;
      } else if (typeof yesContract.last_trade_price === "number") {
        prob = yesContract.last_trade_price as number;
      }
    }
    const slug = (ev.slug as string) ?? null;
    const rawCategory = (ev.category as string) ?? null;
    const category = rawCategory ? rawCategory.toLowerCase().replace(/\s+/g, "-") : null;
    const market_url = slug && category
      ? `https://robinhood.com/us/en/prediction-markets/${category}/events/${slug}/`
      : null;
    results.push({ platform: "robinhood" as Platform, market_id: id, market_title: title, market_url, implied_yes_prob: prob });
  }
  return results;
}

function extractKalshiResults(payload: unknown, _query?: string): SearchResult[] {
  const p = payload as Record<string, unknown>;

  // Wire kl_events (with query param) returns { markets: [...] } flat list
  if (Array.isArray(p.markets)) {
    return (p.markets as Array<Record<string, unknown>>).slice(0, 10).flatMap((m) => {
      const id = (m.market_id as string) ?? (m.ticker as string) ?? null;
      const title = (m.title as string) ?? null;
      if (!id || !title) return [];
      const yes_bid = typeof m.yes_bid === "number" ? m.yes_bid : null;
      const yes_ask = typeof m.yes_ask === "number" ? m.yes_ask : null;
      const last = typeof m.last_price === "number" ? m.last_price : null;
      let prob: number | null = null;
      if (yes_bid !== null && yes_ask !== null) {
        // Prices are in cents (0-100); divide by 100
        prob = (yes_bid + yes_ask) / 200;
      } else if (last !== null) {
        prob = last / 100;
      }
      return [{ platform: "kalshi" as Platform, market_id: id, market_title: title, market_url: `https://kalshi.com/markets/${id}`, implied_yes_prob: prob }];
    });
  }

  // Fallback: kl_events bulk shape { events: [{ event_ticker, title, markets: [{ticker, title}] }] }
  if (Array.isArray(p.events)) {
    const queryTokens = (_query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const results: SearchResult[] = [];
    for (const event of p.events as Array<Record<string, unknown>>) {
      const markets = Array.isArray(event.markets) ? (event.markets as Array<Record<string, unknown>>) : [];
      if (markets.length > 0) {
        for (const market of markets) {
          const ticker = (market.ticker as string) ?? null;
          const title = (market.title as string) ?? (event.title as string) ?? null;
          if (!ticker || !title) continue;
          if (queryTokens.length > 0 && !queryTokens.some((t) => title.toLowerCase().includes(t))) continue;
          const yes_bid = typeof market.yes_bid === "number" ? market.yes_bid : null;
          const yes_ask = typeof market.yes_ask === "number" ? market.yes_ask : null;
          const last = typeof market.last_price === "number" ? market.last_price : null;
          let prob: number | null = null;
          if (yes_bid !== null && yes_ask !== null) prob = (yes_bid + yes_ask) / 200;
          else if (last !== null) prob = last / 100;
          results.push({ platform: "kalshi" as Platform, market_id: ticker, market_title: title, market_url: `https://kalshi.com/markets/${ticker}`, implied_yes_prob: prob });
          if (results.length >= 10) return results;
        }
      } else {
        const ticker = (event.event_ticker as string) ?? null;
        const title = (event.title as string) ?? null;
        if (!ticker || !title) continue;
        if (queryTokens.length > 0 && !queryTokens.some((t) => title.toLowerCase().includes(t))) continue;
        results.push({ platform: "kalshi" as Platform, market_id: ticker, market_title: title, market_url: `https://kalshi.com/markets/${ticker}`, implied_yes_prob: null });
        if (results.length >= 10) return results;
      }
    }
    return results;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Search configs
// ---------------------------------------------------------------------------

const SEARCH_CONFIGS: Array<{
  platform: Platform;
  action: string;
  params: (q: string) => Record<string, unknown>;
  extract: (payload: unknown, query: string) => SearchResult[];
}> = [
  {
    platform: "kalshi",
    action: "kl_events",
    params: (q) => ({ query: q, limit: 10 }),
    extract: extractKalshiResults,
  },
  {
    platform: "manifold",
    action: "mm_search_markets",
    params: (q) => ({ term: q, filter: "open", contract_type: "BINARY", limit: 10 }),
    extract: extractManifoldResults,
  },
  {
    platform: "polymarket",
    action: "pm_search_markets",
    params: (q) => ({ query: q, limit: 10 }),
    extract: extractPolymarketResults,
  },
  {
    platform: "robinhood",
    action: "rh_get_markets",
    params: (q) => ({ search: q, limit: 10, live_only: true }),
    extract: extractRobinhoodResults,
  },
];

// ---------------------------------------------------------------------------
// searchAllPlatforms
// ---------------------------------------------------------------------------

/**
 * Fan out the query to the specified platforms in parallel and return merged results.
 */
export async function searchPlatforms(
  userId: string,
  query: string,
  platforms: Platform[]
): Promise<SearchResult[]> {
  const configs = SEARCH_CONFIGS.filter((c) => platforms.includes(c.platform));

  const settled = await Promise.allSettled(
    configs.map(({ action, params, extract }) =>
      wireRequest(userId, action, params(query)).then((payload) => extract(payload, query))
    )
  );

  const results: SearchResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === "fulfilled") {
      results.push(...result.value);
    } else {
      const err = result.reason;
      if (err instanceof WireError) {
        if (err.class === "key-missing" || err.class === "key-invalid") throw err;
        console.warn(`[search] Wire error on ${configs[i].platform}: ${err.class}`);
      } else {
        console.warn(`[search] Unexpected error on ${configs[i].platform}:`, err);
      }
    }
  }
  return results;
}

/** Search all supported platforms (kalshi, manifold, polymarket, robinhood). */
export async function searchAllPlatforms(userId: string, query: string): Promise<SearchResult[]> {
  return searchPlatforms(userId, query, SEARCH_CONFIGS.map((c) => c.platform));
}
