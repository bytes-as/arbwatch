# Wire fixture files

This directory contains static JSON fixtures used when `WIRE_MODE=fixtures`
(the default in `.env.development`, `preview.sh`, and CI). The Wire client
short-circuits before any HTTP call and reads from these files instead.

## Directory layout

```
tests/fixtures/wire/
  kl_events/
    <query-slug>.json       # Kalshi fixture for this query
    __default__.json        # Fallback when no slug-specific file exists
  mm_search_markets/
    <query-slug>.json       # Manifold fixture for this query
    __default__.json
  pm_get_events/
    <query-slug>.json       # Polymarket fixture for this query
    __default__.json
  rh_get_events/
    <query-slug>.json       # Robinhood fixture for this query
    __default__.json
```

A `<query-slug>` is the kebab-cased input query string (e.g.
`"Fed cuts rates June 2026"` → `fed-cuts-rates-june-2026`). The slugify
function in `lib/wire/fixtures.ts` performs the transformation.

The `__default__.json` file for each action returns an empty-results payload
so that any watched question without a recorded fixture does not crash the
matcher — it simply produces zero matches for that platform.

## How to record a new fixture

1. Set `WIRE_MODE=live` and `ANAKIN_API_KEY=<your-key>` in `.env.local`.
2. Run:
   ```
   bun run scripts/record-wire-fixture.ts \
     --action kl_events \
     --query "will trump win 2028"
   ```
3. The script calls Wire with your dev key, redacts the `Authorization` header
   and any `apiKey`/`api_key`/`anakin_key` fields from the response, and writes
   the result to `tests/fixtures/wire/kl_events/will-trump-win-2028.json`.
4. Commit the file. `preview.sh` and CI now resolve that query without live
   Wire calls.

See `scripts/record-wire-fixture.ts` for the full auth-redaction logic
(Pino redact paths: `["headers.authorization", "*.apiKey", "*.api_key",
"*.anakin_key"]` per ADR-0002 §"Per-call credential injection").

## Field-mapping convention

The canonical field-mapping rules are defined in
`docs/architecture/0002-wire-integration.md` §"Field mapping per platform".

Summary (midpoint-of-YES-bid/ask, fallback to last-trade):

| Platform  | Action             | YES bid path                             | YES ask path                             | Last-trade path                             | Units   |
|-----------|--------------------|------------------------------------------|------------------------------------------|----------------------------------------------|---------|
| Kalshi    | `kl_events`        | `markets[i].yes_bid`                    | `markets[i].yes_ask`                    | `markets[i].last_price`                      | cents/100 |
| Manifold  | `mm_search_markets`| `markets[i].probability`                | `markets[i].probability`                | `markets[i].probability`                     | [0,1]   |
| Polymarket| `pm_get_events`    | `events[i].markets[j].outcomes[YES].bid`| `events[i].markets[j].outcomes[YES].ask`| `events[i].markets[j].outcomes[YES].last_trade_price` | [0,1] |
| Robinhood | `rh_get_events`    | `events[i].contracts[YES].bid_price`    | `events[i].contracts[YES].ask_price`    | `events[i].contracts[YES].last_trade_price`  | [0,1]   |

YES identification:
- Polymarket: `outcomes[*].name === "Yes"` (capital Y, lowercase es)
- Robinhood: `contracts[*].side === "yes"` (all lowercase)

## Seeded queries and expected platform coverage

These 5 queries are defined in `tests/seeds/matching-queries.yaml` and have
fixtures recorded here. Three of the five match on all 4 platforms (required
by the DoD: "matching finds markets across all 4 platforms for ≥3 of 5 seeded
queries").

| Slug                         | Query text                        | kl | mm | pm | rh |
|------------------------------|-----------------------------------|----|----|----|----|
| `fed-cuts-rates-june-2026`   | Fed cuts rates June 2026          | Y  | Y  | Y  | Y  |
| `presidential-election-2028` | Presidential election 2028 winner | Y  | Y  | Y  | Y  |
| `nfl-superbowl-lx`           | NFL Super Bowl LX winner          | Y  | Y  | Y  | Y  |
| `nyc-mayor-2025`             | NYC mayor 2025 election           | Y  | -  | Y  | -  |
| `oscars-best-picture-2027`   | Oscars best picture 2027          | -  | Y  | Y  | -  |

Legend: Y = fixture with results exists; `-` = platform uses `__default__.json`
(empty results, no match row persisted for that platform).

## Implied probability values (for cross-platform spread verification)

For the first query (`fed-cuts-rates-june-2026`), the expected midpoint
`implied_yes_prob` values per platform are:

| Platform   | bid  | ask  | midpoint |
|------------|------|------|----------|
| Kalshi     | 0.42 | 0.44 | **0.43** |
| Manifold   | 0.45 | 0.45 | **0.45** |
| Polymarket | 0.39 | 0.41 | **0.40** |
| Robinhood  | 0.42 | 0.44 | **0.43** |

Spread = max − min = 0.45 − 0.40 = **0.05** (5 percentage points).
This non-zero spread is used by field-mapping tests to verify the convention
end-to-end.
