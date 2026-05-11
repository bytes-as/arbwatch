/**
 * lib/matching.ts
 *
 * Cross-platform matching engine (ADR-0002).
 *
 * matchQuestion(userId, questionId, queryText) fans out to all 4 Wire actions
 * in parallel, extracts per-platform market refs, and upserts into
 * question_matches keyed on (question_id, platform).
 *
 * On WireError({ class: "key-missing" }): throws immediately — no partial rows.
 * On per-platform Wire failures: skips that platform and records in errors[].
 *
 * Kalshi note: kl_events returns up to 50 events with no text search. All
 * candidates are extracted and the embedding layer (if configured) picks the
 * best match. Without embeddings, the first event is used.
 */

import { randomUUID } from "node:crypto";
import { wireRequest } from "./wire/client";
import { WireError } from "./wire/errors";
import {
  extractImpliedYesProb,
  extractMarketId,
  extractMarketTitle,
  extractMarketUrl,
} from "./wire/mapping";
import { matchWithEmbeddings, embedText } from "./matching/embeddings";
import { sqlite } from "../db/client";

type Platform = "kalshi" | "manifold" | "polymarket" | "robinhood";

// ---------------------------------------------------------------------------
// Fresh price fetching (called immediately on question add)
// ---------------------------------------------------------------------------

const PLATFORM_DETAIL_ACTION: Record<string, string> = {
  kalshi: "kl_market_detail",
  manifold: "mm_market_prob",
  polymarket: "pm_get_market",
  robinhood: "rh_get_event",
};

function detailParams(platform: string, marketId: string): Record<string, unknown> {
  if (platform === "kalshi") return { ticker: marketId };
  if (platform === "manifold") return { market_id: marketId };
  if (platform === "polymarket") return { market_id: marketId };
  if (platform === "robinhood") return { event_id: marketId };
  return {};
}

/**
 * Fetch fresh prices for a set of pre-matched markets by calling the detail
 * Wire action for each platform in parallel. Returns probs in the same index
 * order as the input array (null if the call failed or returned no price).
 */
export async function fetchFreshPrices(
  userId: string,
  matches: Array<{ platform: string; market_id: string }>
): Promise<Array<number | null>> {
  const settled = await Promise.allSettled(
    matches.map(async ({ platform, market_id }) => {
      const action = PLATFORM_DETAIL_ACTION[platform];
      if (!action) return null;
      const payload = await wireRequest(userId, action, detailParams(platform, market_id));
      return extractImpliedYesProb(platform, payload);
    })
  );
  return settled.map((r) => (r.status === "fulfilled" ? r.value : null));
}

const PLATFORM_SEARCH_CONFIG: Array<{
  platform: Platform;
  action: string;
  searchParams: (queryText: string) => Record<string, unknown>;
}> = [
  {
    platform: "kalshi",
    action: "kl_events",
    // Kalshi has NO text search — get open events, embedding picks best
    searchParams: () => ({ status: "open", with_nested_markets: true, limit: 50 }),
  },
  {
    platform: "manifold",
    action: "mm_search_markets",
    searchParams: (q) => ({ term: q, filter: "open", contract_type: "BINARY", limit: 10 }),
  },
  {
    platform: "polymarket",
    action: "pm_search_markets",
    searchParams: (q) => ({ query: q, limit: 10 }),
  },
  {
    platform: "robinhood",
    action: "rh_get_markets",
    searchParams: (q) => ({ search: q, limit: 20, live_only: true }),
  },
];

export interface MatchRow {
  platform: Platform;
  market_id: string;
  market_url: string | null;
  implied_yes_prob: number | null;
  market_title: string | null;
}

export interface MatchResult {
  question_id: string;
  platforms_matched: Platform[];
  errors: Array<{ platform: Platform; error: string }>;
}

/**
 * Extract all market candidates from a platform payload.
 * Kalshi can return many events; others return relevance-sorted results so we take the first.
 */
function extractCandidates(
  platform: Platform,
  payload: unknown
): Array<{ marketId: string; title: string | null }> {
  if (platform === "kalshi") {
    const p = payload as Record<string, unknown>;
    // Search shape: events[*].markets[*]
    if (Array.isArray(p.events)) {
      const candidates: Array<{ marketId: string; title: string | null }> = [];
      for (const event of p.events as Array<Record<string, unknown>>) {
        const markets = Array.isArray(event.markets)
          ? (event.markets as Array<Record<string, unknown>>)
          : [];
        if (markets.length > 0) {
          for (const market of markets) {
            const ticker = (market.ticker as string) ?? null;
            const title = (market.title as string) ?? (event.title as string) ?? null;
            if (ticker) candidates.push({ marketId: ticker, title });
          }
        } else {
          const ticker = (event.event_ticker as string) ?? null;
          const title = (event.title as string) ?? null;
          if (ticker) candidates.push({ marketId: ticker, title });
        }
      }
      return candidates;
    }
  }

  // For other platforms (or Kalshi detail shape), take the first match
  const marketId = extractMarketId(platform, payload);
  if (!marketId) return [];
  const title = extractMarketTitle(platform, payload);
  return [{ marketId, title }];
}

/**
 * Match a watched question across all 4 platforms.
 *
 * Throws WireError({ class: "key-missing" }) if the user has no key — no
 * partial rows are persisted in that case.
 */
export async function matchQuestion(
  userId: string,
  questionId: string,
  queryText: string
): Promise<MatchRow[]> {
  // Fan out to all 4 platforms in parallel. Promise.allSettled prevents one
  // platform failure from aborting the others.
  const settled = await Promise.allSettled(
    PLATFORM_SEARCH_CONFIG.map(({ platform, action, searchParams }) =>
      wireRequest(userId, action, searchParams(queryText)).then((payload) => ({
        platform,
        payload,
      }))
    )
  );

  // If the key is missing, the first settled rejection will carry WireError
  // with class="key-missing". We must throw it before persisting anything.
  for (const result of settled) {
    if (result.status === "rejected") {
      const err = result.reason;
      if (err instanceof WireError && err.class === "key-missing") {
        throw err;
      }
    }
  }

  // Collect all candidates across platforms for embedding scoring
  interface PlatformCandidate {
    platform: Platform;
    marketId: string;
    title: string | null;
    payload: unknown;
  }
  const allCandidates: PlatformCandidate[] = [];

  for (const result of settled) {
    if (result.status === "rejected") continue;
    const { platform, payload } = result.value;
    const candidates = extractCandidates(platform, payload);
    for (const c of candidates) {
      allCandidates.push({ platform, marketId: c.marketId, title: c.title, payload });
    }
  }

  // Embedding-based re-ranking (when OPENAI_API_KEY is configured)
  let embeddingScores: Map<string, number> | null = null;
  if (process.env.OPENAI_API_KEY && allCandidates.length > 0) {
    try {
      const embeddableCandidates = allCandidates
        .filter((c) => c.title !== null)
        .map((c) => ({ marketId: c.marketId, title: c.title!, platform: c.platform }));

      if (embeddableCandidates.length > 0) {
        const embeddingResults = await matchWithEmbeddings(queryText, embeddableCandidates);
        if (embeddingResults) {
          embeddingScores = new Map(embeddingResults.map((r) => [r.marketId, r.matchScore]));

          // Persist query embedding
          const queryVec = await embedText(queryText);
          if (queryVec) {
            sqlite
              .prepare(`UPDATE watched_questions SET embedding = ? WHERE id = ?`)
              .run(Buffer.from(queryVec.buffer), questionId);
          }
        }
      }
    } catch {
      // Embedding scoring is best-effort; Phase-1 matches remain intact.
    }
  }

  const rows: MatchRow[] = [];
  const now = Date.now();

  for (const result of settled) {
    if (result.status === "rejected") continue;
    const { platform, payload } = result.value;

    const candidates = extractCandidates(platform, payload);
    if (candidates.length === 0) continue;

    // Pick best candidate: highest embedding score or first
    let bestCandidate = candidates[0];
    if (embeddingScores && candidates.length > 1) {
      let bestScore = -Infinity;
      for (const c of candidates) {
        const score = embeddingScores.get(c.marketId) ?? -Infinity;
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = c;
        }
      }
    }

    const marketId = bestCandidate.marketId;
    const marketTitle = bestCandidate.title;
    const impliedYesProb = extractImpliedYesProb(platform, payload);
    const marketUrl = extractMarketUrl(platform, payload);
    const matchScore = embeddingScores?.get(marketId) ?? null;

    const row: MatchRow = {
      platform,
      market_id: marketId,
      market_url: marketUrl,
      implied_yes_prob: impliedYesProb,
      market_title: marketTitle,
    };

    sqlite
      .prepare(
        `INSERT INTO question_matches
           (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (question_id, platform) DO UPDATE SET
           market_id = excluded.market_id,
           market_url = excluded.market_url,
           implied_yes_prob = excluded.implied_yes_prob,
           last_seen_at = excluded.last_seen_at`
      )
      .run(
        randomUUID(),
        questionId,
        platform,
        marketId,
        marketUrl ?? null,
        impliedYesProb ?? null,
        now
      );

    if (matchScore !== null) {
      sqlite
        .prepare(
          `UPDATE question_matches SET match_score = ?
           WHERE question_id = ? AND platform = ?`
        )
        .run(matchScore, questionId, platform);
    }

    rows.push(row);
  }

  return rows;
}
