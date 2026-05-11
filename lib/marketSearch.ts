/**
 * lib/marketSearch.ts
 *
 * Shared search logic extracted from app/api/search/route.ts.
 * Fans out a text query to all supported prediction market platforms in parallel.
 *
 * Kalshi is excluded from text search (no text-search API).
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

function extractManifoldResults(payload: unknown): SearchResult[] {
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

function extractPolymarketResults(payload: unknown): SearchResult[] {
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

function extractRobinhoodResults(payload: unknown): SearchResult[] {
  const p = payload as Record<string, unknown>;
  const results: SearchResult[] = [];
  for (const ev of asArray(p.events).slice(0, 10)) {
    const id = ev.id as string | undefined;
    const title = (ev.name as string) ?? null;
    if (!id || !title) continue;
    const contracts = asArray(ev.contracts);
    // Skip multi-outcome events (many contracts = one per outcome person/team etc.)
    // We only want binary YES/NO events (1-2 contracts)
    if (contracts.length > 2) continue;
    if (results.length >= 10) break;
    let prob: number | null = null;
    if (contracts.length > 0) {
      const c = contracts[0];
      const bid = c.yes_bid as number | undefined;
      const ask = c.yes_ask as number | undefined;
      if (typeof bid === "number" && typeof ask === "number" && bid <= ask) {
        prob = (bid + ask) / 2;
      } else if (typeof c.last_trade_price === "number") {
        prob = c.last_trade_price as number;
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

// ---------------------------------------------------------------------------
// Search configs
// ---------------------------------------------------------------------------

const SEARCH_CONFIGS: Array<{
  platform: Platform;
  action: string;
  params: (q: string) => Record<string, unknown>;
  extract: (payload: unknown) => SearchResult[];
}> = [
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
 * Kalshi is excluded (no text-search API) — omit it from `platforms`.
 */
export async function searchPlatforms(
  userId: string,
  query: string,
  platforms: Platform[]
): Promise<SearchResult[]> {
  const configs = SEARCH_CONFIGS.filter((c) => platforms.includes(c.platform));

  const settled = await Promise.allSettled(
    configs.map(({ action, params, extract }) =>
      wireRequest(userId, action, params(query)).then((payload) => extract(payload))
    )
  );

  const results: SearchResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.push(...result.value);
    } else {
      const err = result.reason;
      if (err instanceof WireError && (err.class === "key-missing" || err.class === "key-invalid")) {
        throw err;
      }
    }
  }
  return results;
}

/** Search all supported platforms (manifold, polymarket, robinhood). */
export async function searchAllPlatforms(userId: string, query: string): Promise<SearchResult[]> {
  return searchPlatforms(userId, query, SEARCH_CONFIGS.map((c) => c.platform));
}
