/**
 * lib/wire/mapping.ts
 *
 * Per-platform JSON path extractor for the real Anakin Wire API responses.
 * ADR-0002 §"Field mapping per platform".
 *
 * Each platform returns two shapes:
 *   - Search shape (from search actions): contains an array wrapper
 *   - Detail shape (from detail actions): top-level market/event object
 *
 * Detection per platform:
 *   Kalshi:     payload.events array → search; else → detail
 *   Manifold:   payload.markets array → search; payload.prob → detail
 *   Polymarket: payload.events array → search; payload.outcomes array → detail
 *   Robinhood:  payload.events array → search; else → detail (no events wrapper)
 *
 * Kalshi prices arrive as dollar strings ("0.0700") and are already in [0,1].
 * Parse with parseFloat. Manifold, Polymarket, Robinhood are plain numbers in [0,1].
 */

type Platform = "kalshi" | "manifold" | "polymarket" | "robinhood";

function asRecord(v: unknown): Record<string, unknown> {
  return (v as Record<string, unknown>) ?? {};
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

// ---------------------------------------------------------------------------
// extractMarketId
// ---------------------------------------------------------------------------

export function extractMarketId(platform: Platform, payload: unknown): string | null {
  const p = asRecord(payload);

  if (platform === "kalshi") {
    if (Array.isArray(p.events)) {
      // search shape: {events: [{event_ticker, markets: [{ticker}]}]}
      const events = asArray(p.events);
      if (events.length === 0) return null;
      const firstEvent = events[0];
      const markets = asArray(firstEvent.markets);
      if (markets.length === 0) {
        // fall back to event_ticker
        return (firstEvent.event_ticker as string) ?? null;
      }
      return (markets[0].ticker as string) ?? null;
    }
    // detail shape: {ticker, ...}
    return (p.ticker as string) ?? null;
  }

  if (platform === "manifold") {
    if (Array.isArray(p.markets)) {
      // search shape: {markets: [{id, question, url, probability}]}
      const markets = asArray(p.markets);
      if (markets.length === 0) return null;
      return (markets[0].id as string) ?? null;
    }
    // detail shape — no standard id field in mm_market_prob; fall through
    return null;
  }

  if (platform === "polymarket") {
    if (Array.isArray(p.events)) {
      // search shape: {events: [{title, markets: [{id, question, outcomes}]}]}
      const events = asArray(p.events);
      if (events.length === 0) return null;
      const markets = asArray(events[0].markets);
      if (markets.length === 0) return null;
      return (markets[0].id as string) ?? null;
    }
    if (Array.isArray(p.outcomes)) {
      // detail shape: {id, question, outcomes: [...]}
      return (p.id as string) ?? null;
    }
    return null;
  }

  if (platform === "robinhood") {
    if (Array.isArray(p.events)) {
      // search shape: {events: [{id, name, slug, contracts}]}
      const events = asArray(p.events);
      if (events.length === 0) return null;
      return (events[0].id as string) ?? null;
    }
    // detail shape: {id, name, slug, contracts}
    return (p.id as string) ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractMarketTitle
// ---------------------------------------------------------------------------

export function extractMarketTitle(platform: Platform, payload: unknown): string | null {
  const p = asRecord(payload);

  if (platform === "kalshi") {
    if (Array.isArray(p.events)) {
      const events = asArray(p.events);
      if (events.length === 0) return null;
      const firstEvent = events[0];
      const markets = asArray(firstEvent.markets);
      if (markets.length > 0) {
        return (markets[0].title as string) ?? (firstEvent.title as string) ?? null;
      }
      return (firstEvent.title as string) ?? null;
    }
    return (p.title as string) ?? null;
  }

  if (platform === "manifold") {
    if (Array.isArray(p.markets)) {
      const markets = asArray(p.markets);
      if (markets.length === 0) return null;
      return (markets[0].question as string) ?? null;
    }
    return null;
  }

  if (platform === "polymarket") {
    if (Array.isArray(p.events)) {
      const events = asArray(p.events);
      if (events.length === 0) return null;
      return (events[0].title as string) ?? null;
    }
    if (Array.isArray(p.outcomes)) {
      return (p.question as string) ?? null;
    }
    return null;
  }

  if (platform === "robinhood") {
    if (Array.isArray(p.events)) {
      const events = asArray(p.events);
      if (events.length === 0) return null;
      return (events[0].name as string) ?? null;
    }
    return (p.name as string) ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractMarketUrl
// ---------------------------------------------------------------------------

export function extractMarketUrl(platform: Platform, payload: unknown): string | null {
  const p = asRecord(payload);

  if (platform === "manifold") {
    if (Array.isArray(p.markets)) {
      const markets = asArray(p.markets);
      if (markets.length === 0) return null;
      return (markets[0].url as string) ?? null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractImpliedYesProb
// ---------------------------------------------------------------------------

/**
 * Compute the implied YES probability from a Wire action response payload.
 *
 * Algorithm:
 * 1. If both bid and ask are present, finite, and bid <= ask → return (bid + ask) / 2.
 * 2. Else if last-trade is present and finite → return last-trade.
 * 3. Else → return null.
 *
 * Kalshi prices are dollar strings already in [0,1] — parse with parseFloat.
 * Manifold, Polymarket, Robinhood values are plain numbers in [0,1].
 */
export function extractImpliedYesProb(platform: string, payload: unknown): number | null {
  if (platform === "kalshi") return extractKalshi(payload);
  if (platform === "manifold") return extractManifold(payload);
  if (platform === "polymarket") return extractPolymarket(payload);
  if (platform === "robinhood") return extractRobinhood(payload);
  return null;
}

function extractKalshi(payload: unknown): number | null {
  const p = asRecord(payload);

  // Detail shape: top-level yes_bid_dollars, yes_ask_dollars, last_price_dollars
  if (!Array.isArray(p.events)) {
    const bid = parseDollarString(p.yes_bid_dollars);
    const ask = parseDollarString(p.yes_ask_dollars);
    const last = parseDollarString(p.last_price_dollars);
    return midpointOrLast(bid, ask, last);
  }

  // Search shape: events[*].markets[*]
  const events = asArray(p.events);
  if (events.length === 0) return null;
  const firstEvent = events[0];
  const markets = asArray(firstEvent.markets);
  if (markets.length === 0) return null;
  const market = markets[0];

  const bid = parseDollarString(market.yes_bid_dollars);
  const ask = parseDollarString(market.yes_ask_dollars);
  const last = parseDollarString(market.last_price_dollars);
  return midpointOrLast(bid, ask, last);
}

function extractManifold(payload: unknown): number | null {
  const p = asRecord(payload);

  // Detail shape: {prob: 0.35}
  if (typeof p.prob === "number" && isFinite(p.prob)) {
    return p.prob;
  }

  // Search shape: {markets: [{probability: 0.35}]}
  if (Array.isArray(p.markets)) {
    const markets = asArray(p.markets);
    if (markets.length === 0) return null;
    const prob = markets[0].probability as number | undefined;
    if (isFiniteNumber(prob)) return prob!;
  }

  return null;
}

function extractPolymarket(payload: unknown): number | null {
  const p = asRecord(payload);

  // Search shape: {events: [{markets: [{outcomes: [{name, bid, ask}]}]}]}
  if (Array.isArray(p.events)) {
    const events = asArray(p.events);
    if (events.length === 0) return null;
    const markets = asArray(events[0].markets);
    if (markets.length === 0) return null;
    return extractYesFromOutcomes(asArray(markets[0].outcomes));
  }

  // pm_get_market detail shape:
  //   {outcomes: ["Yes", "No"], outcome_prices: [float, float],
  //    best_bid: float|null, best_ask: float|null, last_trade_price: float|null}
  if (Array.isArray(p.outcomes) && typeof p.outcomes[0] === "string") {
    const bid = isFiniteNumber(p.best_bid) ? (p.best_bid as number) : null;
    const ask = isFiniteNumber(p.best_ask) ? (p.best_ask as number) : null;
    const last = isFiniteNumber(p.last_trade_price) ? (p.last_trade_price as number) : null;
    const mid = midpointOrLast(bid, ask, last);
    if (mid !== null) return mid;
    // Fall back to outcome_prices[indexOf("Yes")]
    const yesIdx = (p.outcomes as string[]).indexOf("Yes");
    if (yesIdx >= 0 && Array.isArray(p.outcome_prices)) {
      const price = (p.outcome_prices as number[])[yesIdx];
      if (isFiniteNumber(price)) return price;
    }
    return null;
  }

  // Legacy fixture detail shape: {id, question, outcomes: [{name, bid, ask}]}
  if (Array.isArray(p.outcomes)) {
    return extractYesFromOutcomes(asArray(p.outcomes));
  }

  return null;
}

function extractYesFromOutcomes(outcomes: Array<Record<string, unknown>>): number | null {
  const yesOutcome = outcomes.find((o) => o.name === "Yes");
  if (!yesOutcome) return null;

  const bid = yesOutcome.bid as number | undefined;
  const ask = yesOutcome.ask as number | undefined;
  const last = yesOutcome.last_trade_price as number | undefined;
  return midpointOrLast(
    isFiniteNumber(bid) ? bid! : null,
    isFiniteNumber(ask) ? ask! : null,
    isFiniteNumber(last) ? last! : null
  );
}

function extractRobinhood(payload: unknown): number | null {
  const p = asRecord(payload);

  let contracts: Array<Record<string, unknown>>;

  // Search shape: {events: [{contracts: [...]}]}
  if (Array.isArray(p.events)) {
    const events = asArray(p.events);
    if (events.length === 0) return null;
    contracts = asArray(events[0].contracts);
  } else {
    // Detail shape: {id, name, contracts: [...]}
    contracts = asArray(p.contracts);
  }

  if (contracts.length === 0) return null;

  // Multi-outcome events (>2 contracts) can't be expressed as a single YES prob.
  // Skip pricing so they don't pollute spread calculations.
  if (contracts.length > 2 && Array.isArray(p.contracts)) return null;

  // New real API: contracts use yes_bid, yes_ask, last_trade_price (plain floats)
  // Pick first contract (no side filter needed — first is YES)
  const first = contracts[0];
  const bid = first.yes_bid as number | undefined;
  const ask = first.yes_ask as number | undefined;
  const last = first.last_trade_price as number | undefined;

  if (isFiniteNumber(bid) || isFiniteNumber(ask) || isFiniteNumber(last)) {
    return midpointOrLast(
      isFiniteNumber(bid) ? bid! : null,
      isFiniteNumber(ask) ? ask! : null,
      isFiniteNumber(last) ? last! : null
    );
  }

  // Legacy fixture format: contracts use bid_price/ask_price and side === "yes"
  const yesContract = contracts.find((c) => c.side === "yes");
  if (yesContract) {
    const legacyBid = yesContract.bid_price as number | undefined;
    const legacyAsk = yesContract.ask_price as number | undefined;
    const legacyLast = yesContract.last_trade_price as number | undefined;
    return midpointOrLast(
      isFiniteNumber(legacyBid) ? legacyBid! : null,
      isFiniteNumber(legacyAsk) ? legacyAsk! : null,
      isFiniteNumber(legacyLast) ? legacyLast! : null
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractCloseDate — ISO string or null
// ---------------------------------------------------------------------------

export function extractCloseDate(platform: string, payload: unknown): string | null {
  const p = asRecord(payload);

  if (platform === "kalshi") {
    // detail: close_time is ISO string
    const t = p.close_time ?? p.expiration_time;
    return typeof t === "string" ? t : null;
  }

  if (platform === "manifold") {
    // mm_market_prob detail may include closeTime (epoch ms)
    const t = p.closeTime;
    if (typeof t === "number") return new Date(t).toISOString();
    return null;
  }

  if (platform === "polymarket") {
    // pm_get_market: end_date ISO string
    const t = p.end_date;
    return typeof t === "string" ? t : null;
  }

  if (platform === "robinhood") {
    // rh_get_event: contracts[0].expiration_date ISO string
    const contracts = asArray(p.contracts);
    if (contracts.length > 0) {
      const t = contracts[0].expiration_date;
      return typeof t === "string" ? t : null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractVolume — raw number (platform-native units) or null
// ---------------------------------------------------------------------------

export function extractVolume(platform: string, payload: unknown): number | null {
  const p = asRecord(payload);

  if (platform === "kalshi") {
    const v = p.volume ?? p.volume_24h;
    return isFiniteNumber(v) ? (v as number) : null;
  }

  if (platform === "manifold") {
    const v = p.volume;
    return isFiniteNumber(v) ? (v as number) : null;
  }

  if (platform === "polymarket") {
    const v = p.volume ?? p.volumeNum;
    return isFiniteNumber(v) ? (v as number) : null;
  }

  if (platform === "robinhood") {
    // contracts[0].open_interest is the most useful liquidity signal
    const contracts = asArray(p.contracts);
    if (contracts.length > 0) {
      const oi = contracts[0].open_interest;
      if (typeof oi === "string") {
        const n = parseFloat(oi);
        return isFinite(n) ? n : null;
      }
      return isFiniteNumber(oi) ? (oi as number) : null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDollarString(v: unknown): number | null {
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  if (typeof v === "number" && isFinite(v)) return v;
  return null;
}

function midpointOrLast(
  bid: number | null,
  ask: number | null,
  last: number | null
): number | null {
  if (bid !== null && ask !== null && bid <= ask) {
    return (bid + ask) / 2;
  }
  if (last !== null) return last;
  return null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && isFinite(v);
}
