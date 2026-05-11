# ADR 0002 — Wire integration and per-user credential scoping

Date: 2026-05-11
Status: Accepted
Supersedes: —
References: ADR-0001 (stack), docs/design/auth-and-onboarding.md

## Context
Phase 1 needs to call four Anakin Wire actions — `kl_events`, `mm_search_markets`,
`pm_get_events`, `rh_get_events` — once per user per 5-minute cron tick (ADR-0001
"Cron"), plus once during the onboarding probe (auth-and-onboarding §2A step 14)
and once on each watched-question add. PROJECT.md mandates BYO-credentials: the
app must never hold a shared Anakin key, every Wire call is billed to the
authenticated user's account, and the user's plaintext key must never leave the
request scope or hit a logger.

Operational constraints from ADR-0001:
- Vercel Hobby Node 20 runtime; **default function timeout 10 s** for the cron
  route. The cron handler iterates all active users in-process for v1, so the
  Wire-call wall-clock per user must stay tight.
- Encrypted key column `users.anakin_key_ct` with layout `nonce(12) ||
  ciphertext || tag(16)`, AAD = `user.id`, decrypted with `@noble/ciphers`
  AES-256-GCM and `APP_ENCRYPTION_KEY` (server env).
- preview.sh boots against seeded SQLite with **no live credentials**; tests and
  local dev must not depend on a real Anakin key.
- The error taxonomy chosen here is referenced verbatim in
  docs/design/auth-and-onboarding.md §5C and §5D and will be asserted by QA.

The dashboard surfaces a sticky banner when a user's key is missing, invalid,
or quota-exhausted (auth-and-onboarding flow 2H), so the backend needs a
machine-readable error tag to write to `users.anakin_key_status`.

## Options considered

### 1. Client library / transport
1. **Typed `fetch` wrapper (`lib/wire/client.ts`).** One module exporting four
   typed functions (`klEvents`, `mmSearchMarkets`, `pmGetEvents`, `rhGetEvents`),
   each accepting `(args, { apiKey, signal })`. Built on the runtime's native
   `fetch`; zero deps; easy to swap for fixtures by env switch. Response types
   live next to the wrapper.
2. **Anakin SDK from npm.** Searched: no first-party `@anakin/wire` SDK is
   published as of 2026-05-11. A community wrapper would add a dep we cannot
   audit and would not understand our per-user-key injection pattern.
3. **OpenAPI-generated client.** Strong types, but Wire's OpenAPI spec is not
   public at the action level; generation would lock us to a snapshot we can't
   refresh. Pure overhead for four endpoints.

### 2. Per-call credential injection
1. **Decrypt-on-demand inside the Wire wrapper, key never leaves the call
   stack.** Caller passes `userId`; wrapper internally calls
   `getDecryptedAnakinKey(userId)` which reads `users.anakin_key_ct`, decrypts
   with the row's AAD, sets the auth header, then drops the plaintext at the
   end of the function (no closure capture, no return).
2. **Decrypt once per cron tick at the top of the handler, pass plaintext into
   each call.** Slightly fewer DB reads, but plaintext lives longer in memory
   and is easier to leak via a stray `console.log(args)`.
3. **Background decryption service.** Overkill at this scale.

### 3. Retry / backoff
1. **One retry on 5xx/429 with 250 ms jitter; hard total budget 6 s per user
   per cron tick** (4 actions × ~1.5 s p95 each, leaving headroom under the
   10 s function ceiling). 401/403/402 do not retry.
2. **Exponential backoff (1 s, 2 s, 4 s).** Blows the function timeout if more
   than one user retries.
3. **No retries.** Misses transient blips that resolve in <500 ms.

### 4. Local-dev fixture mode
1. **`WIRE_MODE=fixtures` env var routes all four calls to JSON files under
   `tests/fixtures/wire/`.** Switch happens inside the wrapper, before any HTTP
   would be issued, so callers don't know the difference. Fixtures committed to
   the repo; preview.sh and CI default to this mode.
2. **MSW (Mock Service Worker).** Heavier; we don't need request matching, just
   a function-level switch.
3. **Separate mock module imported via tsconfig path alias.** Diverges the dev
   import graph from prod — a footgun.

### 5. Field mapping convention
The four Wire actions return platform-shaped data. To compute
`spread = max(implied_yes_prob) − min(implied_yes_prob)`, every platform must
yield `implied_yes_prob` via the **same convention**. Options:
1. **YES bid.** Conservative (what a YES seller can hit immediately), but Manifold's
   AMM has no resting bid — would force a synthetic.
2. **YES ask.** Symmetric problem on Manifold; also overstates true price during
   wide spreads.
3. **Midpoint of YES bid/ask.** Defined for all four platforms via either an
   order-book midpoint (Kalshi, Polymarket, RH) or the AMM instantaneous price
   (Manifold reports a single probability, treated as both bid and ask).
4. **Last YES trade price.** Stale on thin markets; can sit minutes off the live
   quote.

Without recorded fixtures yet (sprint 2 deliverable), we commit to (3) with a
documented fallback to (4) when no quote is available, and a TODO checklist
below.

## Decision

**A typed `fetch` wrapper at `lib/wire/client.ts` that decrypts the user's
Anakin key on demand inside each call, retries once on 5xx/429 with a 6 s
per-user wall-clock budget, switches to JSON fixtures when `WIRE_MODE=fixtures`,
treats `midpoint of YES bid/ask, falling back to last YES trade if no quote` as
the universal `implied_yes_prob` convention, and tags every Wire failure as
exactly one of `key-missing | key-invalid | quota-exhausted | transient | other`.**

One-sentence reason: the typed-fetch wrapper is the smallest design that
satisfies BYO-credentials, the 10 s Vercel function ceiling (ADR-0001
"Locked-in specifics → Cron"), and the no-live-keys preview.sh requirement,
while exposing exactly the three error tags the dashboard banner spec already
references.

### Locked-in specifics

#### Module layout
```
lib/wire/
  client.ts          # exported callers: klEvents, mmSearchMarkets, pmGetEvents, rhGetEvents
  errors.ts          # WireError class + classify(response, body) → tag
  fixtures.ts        # loads tests/fixtures/wire/<action>/<slug>.json when WIRE_MODE=fixtures
  mapping.ts         # extractImpliedYesProb(platform, payload) → number | null
  decrypt.ts         # getDecryptedAnakinKey(userId) → string, plaintext-scoped to caller
tests/fixtures/wire/
  kl_events/<slug>.json
  mm_search_markets/<slug>.json
  pm_get_events/<slug>.json
  rh_get_events/<slug>.json
  README.md          # fixture recording instructions (written by QA in sprint 2)
```

#### Per-call credential injection (cross-references ADR-0001 "Encryption key")
1. The cron handler (and `/api/key/probe`, `/api/watched-questions` POST)
   receives `userId` from session or row.
2. It calls `wire.<action>({ userId, ...args }, { signal })`. The wrapper:
   a. Reads `users.anakin_key_ct` for that `userId` (single SELECT).
   b. Calls `decryptAESGCM({ ct: row.anakin_key_ct, aad: userId, key:
      APP_ENCRYPTION_KEY })` — pure function, returns a `string` bound only to
      this call frame.
   c. Sets header `Authorization: Bearer ${plaintext}` on the outgoing
      `fetch`.
   d. The plaintext is **never** logged, never returned, never put in an
      error message, never JSON-stringified. The wrapper's internal logger
      uses a Pino redact path of `["headers.authorization", "*.apiKey",
      "*.api_key", "*.anakin_key"]` so even an accidental object dump is
      scrubbed.
   e. After the `fetch` resolves the local `plaintext` variable falls out of
      scope; no closure or retry queue captures it. Retry re-decrypts.
3. **Probe path** (onboarding §2A step 14): same wrapper, but with the freshly
   pasted plaintext key passed *directly* via an internal `_rawKey` argument
   (used only by the probe so we don't need to write-then-read the encrypted
   row before validation). All other paths must use the encrypted-row lookup.

#### Retry / backoff
- 5xx and 429 → **one retry** after `250 ms ± 100 ms` jitter. Total max wall
  clock per call: ~5 s. With four sequential actions per user that gives a
  hard budget of 6 s per user per cron tick.
- The cron handler enforces a global `AbortController` set to **8 s** so we
  always return before the 10 s function timeout, even if a single user's
  Wire calls hang.
- 401/403 → no retry, classify as `key-invalid`.
- 402 / quota-style 429 with `code=quota_exhausted` body (or
  `X-Anakin-Quota-Remaining: 0` header) → no retry, classify as
  `quota-exhausted`.
- Any other non-2xx after retry → classify as `transient` (skip user this
  tick, do not flip `anakin_key_status`).

#### Rate-limit handling (`quota-exhausted`)
- On detection, the cron handler:
  1. Updates `users.anakin_key_status = 'quota-exhausted'`.
  2. Updates `users.anakin_key_status_at = now()`.
  3. Skips this user for the remainder of the tick (no further actions).
  4. Will retry on the next tick — Wire quotas reset hourly per Anakin docs;
     5-minute cron cadence will pick the user back up automatically. Cooldown
     is implicit, no extra timer needed.
  5. Dashboard reads `anakin_key_status` and renders the banner copy from
     auth-and-onboarding §5D ("Your Anakin account is out of Wire quota…").

#### Local-dev fixture mode
- Env var: `WIRE_MODE` ∈ `{live, fixtures}`. Default in `.env.development` and
  preview.sh: `fixtures`. Default in Vercel prod: `live`.
- When `WIRE_MODE=fixtures` the wrapper short-circuits before any network call
  and reads from `tests/fixtures/wire/<action>/<slug>.json`.
- **Fixture file naming:** `<action>/<query-slug>.json` where `query-slug` is
  the kebab-cased input query (e.g.
  `mm_search_markets/will-trump-win-2028.json`). A special slug `__default__`
  is loaded when no slug-specific file exists, so a developer can add a
  watched question without recording a fixture for it.
- **Recording new fixtures (developer flow):**
  1. Set `WIRE_MODE=live` and `ANAKIN_API_KEY=<your-key>` in
     `.env.local`.
  2. Run `bun run scripts/record-wire-fixture.ts --action kl_events --query
     "will trump win 2028"`.
  3. Script calls Wire with the dev key, redacts the response per the redact
     path above, and writes the JSON to
     `tests/fixtures/wire/kl_events/will-trump-win-2028.json`.
  4. Commit. preview.sh and CI now resolve that query without live calls.

#### Field mapping per platform — `implied_yes_prob`
Per the rationale in §5 above, the universal convention is **midpoint of YES
bid/ask, falling back to last YES trade price if either side of the book is
missing**.

| Platform | Wire action | Path to YES bid | Path to YES ask | Path to last YES trade | Notes |
|---|---|---|---|---|---|
| Kalshi | `kl_events` | `markets[i].yes_bid` (cents 0-100, divide by 100) | `markets[i].yes_ask` (cents) | `markets[i].last_price` (cents) | Kalshi quotes in cents; mapper divides by 100. |
| Manifold | `mm_search_markets` | `markets[i].probability` | `markets[i].probability` | `markets[i].probability` | AMM single price; bid == ask == midpoint == "last". |
| Polymarket | `pm_get_events` | `events[i].markets[j].outcomes[YES].bid` | `events[i].markets[j].outcomes[YES].ask` | `events[i].markets[j].outcomes[YES].last_trade_price` | YES outcome identified by `outcomes[*].name === "Yes"`. Values already in [0, 1]. |
| Robinhood | `rh_get_events` | `events[i].contracts[YES].bid_price` | `events[i].contracts[YES].ask_price` | `events[i].contracts[YES].last_trade_price` | YES contract identified by `contracts[*].side === "yes"`. Values in [0, 1]. |

`extractImpliedYesProb(platform, payload) → number | null`:
1. If both bid and ask are present and finite and `bid <= ask`, return
   `(bid + ask) / 2`.
2. Else if last-trade is present and finite, return last-trade.
3. Else return `null`. The match is dropped from the spread calculation for
   that tick (does not throw).

> **TODO (sprint 2 — QA agent recording fixtures, blocks final mapping
> sign-off):** Confirm against live Wire payloads:
> - exact JSON paths above (key names and nesting) per platform,
> - units (cents vs decimal vs basis points),
> - YES outcome identifier on Polymarket (`"Yes"` vs `"YES"` vs `outcome_id`),
> - whether Manifold returns a `probability` field for non-binary markets and
>   how to filter to binary YES/NO,
> - whether Robinhood `contracts[*].side` is `"yes"` or `"YES"` or an enum int.
>
> Any mismatch updates `lib/wire/mapping.ts` only — no ADR change needed
> unless the convention itself becomes unworkable (e.g., a platform exposes
> only a midpoint and no underlying bid/ask, in which case revisit the
> fallback chain).

#### Error taxonomy (verbatim names — referenced by auth-and-onboarding §5C, §5D, and QA tests)

| Tag | Detection rule | Orchestrator behavior | User-facing surface |
|---|---|---|---|
| `key-missing` | `users.anakin_key_ct IS NULL` (no Wire call attempted). | Cron skips user for the tick. No status flip needed (already implicit). Onboarding redirect already enforced by middleware (auth-and-onboarding §2A). | Dashboard banner: "No Anakin API key is on file. Add your key to resume spread tracking." (§5D) |
| `key-invalid` | HTTP 401 or 403 from any Wire action; OR probe response body matches `{ "error": { "code": "invalid_api_key" \| "unauthorized" } }`. | Cron sets `users.anakin_key_status = 'key-invalid'`, sets `anakin_key_status_at = now()`, skips user. Onboarding probe shows inline error and does not save the key. | Dashboard banner: "Your Anakin API key is no longer valid. Update your key…" (§5D) and onboarding inline error: "Anakin rejected this key…" (§5C) |
| `quota-exhausted` | HTTP 402; OR HTTP 429 with body `{ "error": { "code": "quota_exhausted" \| "rate_limit_exceeded" } }`; OR header `X-Anakin-Quota-Remaining: 0`. | Cron sets `users.anakin_key_status = 'quota-exhausted'`, skips user this tick, retries automatically next tick (5 min cooldown is implicit). | Dashboard banner: "Your Anakin account is out of Wire quota…" (§5D) and onboarding inline error: "Your Anakin account has no remaining Wire quota…" (§5C) |

Two additional **internal-only** classifications that are not part of the
public taxonomy but exist in code so the cron handler's branching is total:
- `transient` — any 5xx after retry, network error, or `AbortError`. Skip
  user this tick; do not flip `anakin_key_status`. No banner.
- `other` — anything unclassified. Same handling as `transient`; logged with
  `severity=warn` for the operator to triage.

`users.anakin_key_status` enum (column added by ADR-0001 schema): `ok |
key-missing | key-invalid | quota-exhausted`. The three failure tags are
exactly the public taxonomy; `ok` is the success state.

## Consequences

**Easier**
- Switching dev/CI between live and fixture mode is a one-env-var change; no
  test harness or HTTP mock library to learn.
- The dashboard banner code is a pure function of `users.anakin_key_status`;
  the frontend never inspects HTTP details.
- The probe path (onboarding) and the cron path share one wrapper, so the
  three error tags are guaranteed identical between onboarding and steady
  state — QA can write one test matrix.
- Sprint 2 can record fixtures by running real Wire calls once and committing
  redacted JSON; tests then run offline forever.

**Harder / locked-in**
- The 6 s per-user wall-clock budget caps in-process fan-out at roughly
  `floor(8s / 6s) ≈ 1` user comfortably per cron tick — but cron iterates
  *sequentially* across users with the same 8 s global abort. **Above ~5
  active users, the in-process loop will start dropping tail users on slow
  ticks.** This is the trigger ADR-0001 already flagged for moving fan-out
  to Inngest; restating it here so the orchestrator wires the alert.
- Committing to `midpoint, fallback last-trade` means platforms with one-sided
  books (e.g. a brand-new Kalshi market with only an ask) fall to last-trade
  silently. If a platform has *neither* a quote nor a recent trade, that
  platform drops out of the spread for that tick — acceptable for Phase 1 but
  worth surfacing in the spread tooltip in Phase 2.
- Manifold's `probability` is an AMM instantaneous price, not a true
  bid/ask — using it as both sides of the midpoint is a deliberate
  approximation. Documented here so a future ADR can replace it (e.g. when we
  add per-share slippage modeling in Phase 3).
- The error taxonomy is locked: any rename (`key-invalid` →
  `invalid-credentials`, etc.) requires updating auth-and-onboarding,
  dashboard banner copy, QA tests, and the DB enum together. New tags can be
  added; existing tags must not be renamed.

## Follow-up stories the orchestrator should add
1. *Sprint 2 (QA):* "Record live Wire fixtures for kl_events, mm_search_markets,
   pm_get_events, rh_get_events covering the 3 seeded test queries; verify
   the field-mapping table in ADR-0002 against actual payloads and update
   `lib/wire/mapping.ts` if any path is wrong." Blocks
   `story-question-matching` final sign-off.
2. *Phase 2 trigger (already noted in ADR-0001 but reinforced here):* "Move
   per-user Wire fan-out to Inngest when active users > 5 OR cron handler
   p95 > 6 s." The 6 s threshold is tighter than ADR-0001's 8 s because we
   now know the per-user wall-clock budget.
3. *Sprint 1 (DevOps/Backend):* "Author `scripts/record-wire-fixture.ts` with
   the redact path described in this ADR, plus
   `tests/fixtures/wire/README.md` documenting the recording flow."
4. *Sprint 1 (Backend):* "Add `users.anakin_key_status` enum column +
   `anakin_key_status_at` timestamp to the schema in ADR-0001 §Locked-in
   specifics → Schema, day one (the column was named there but not typed)."
