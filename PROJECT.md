# predmkt-arb — Cross-platform prediction-market arbitrage scanner

> Self-serve web app that surfaces arbitrage spreads across Kalshi, Manifold,
> Polymarket, and Robinhood Prediction Markets for active retail traders.
> Users bring their own Anakin Wire key; we match questions across platforms
> and ping when spreads open. No custody, no advice, no metered credits on
> us — pure data plus alerts.

## Vision
A year from now: 1,000+ users on a free tier (read-only dashboard, 5 watched
questions, weekly digest), 100+ on a paid tier ($19/mo, unlimited questions,
real-time alerts, custom rules, deeplinks with suggested stakes), and a power
tier ($99/mo) doing capital-managed auto-execution against the user's own
Kalshi REST and Polymarket Polygon accounts. The moat is the cross-platform
question-matching engine (semantic + structural identity) plus the alerting
UX — competitors do one platform, we do four. Year-end targets: $20K ARR,
80%+ DAU/WAU on free tier, organic growth via r/prediction_markets and Twitter.

## Phases
The orchestrator delivers in sequential phases. Each has its own success
criteria; the project is complete when the last phase's criteria are all green.

### Phase 1 — MVP: Watched questions + email alerts
Email magic-link signup, user pastes their own Anakin API key during
onboarding, up to 5 watched questions via free-text query, cross-platform
matching via Anakin Wire actions (kl_events, mm_search_markets, pm_get_events,
rh_get_events) using the *user's* key, spreads refreshed every 5 min,
templated email when spread > 3%. Demo-ready polish.

**Success criteria** (QA-verified):
- [ ] User signs up via email magic-link; session persists across browser restarts
- [ ] During onboarding, user pastes an Anakin API key; key is encrypted at rest and used for that user's Wire calls only
- [ ] If a user's Anakin key is missing, invalid, or quota-exhausted, dashboard surfaces a clear error and that user's spread refresh is paused
- [ ] User adds up to 5 watched questions by free-text query; matching finds markets across all 4 platforms for ≥3 of 5 seeded test queries
- [ ] Cron updates spreads at least every 5 min per user; spread = max(implied_yes_prob) − min(implied_yes_prob) across platforms where the question exists
- [ ] When spread crosses the threshold (default 3%), email sent within 60s of cron run
- [ ] Dashboard shows watched questions with current spread, last-updated, deeplinks to all 4 platform market pages
- [ ] ./preview.sh starts service against seeded SQLite (3 test questions, 1 fixture user) and prints http://localhost:3000
- [ ] README quickstart works copy-pasted to a local-running service in <60s
- [ ] UI shows the disclaimer "arb ≠ profit; slippage and fees may eat spread" on every spread view

### Phase 2 — v1.5: Multi-user + smarter matching
Per-question custom thresholds, web-push notifications, embedding-based
matching (free-text → semantic), historical spread chart. Trigger to start:
≥10 organic MVP signups.

**Success criteria:**
- [ ] Two or more users use the system simultaneously with isolated watched lists and isolated Anakin keys
- [ ] Per-question custom threshold (override of global 3%) works end-to-end
- [ ] Web-push notification delivered to a subscribed browser within 60s of threshold crossing
- [ ] Embedding-based matching beats Phase 1 free-text matching on a seeded eval set (≥80% accuracy)
- [ ] Each question shows a 7-day spread history chart

### Phase 3 — v2: Paid tier
Stripe billing, Google SSO, Free plan (5 questions) and Paid plan ($19/mo,
unlimited), custom rule engine ("alert when Kalshi–Polymarket spread on any
election market exceeds 4%"). Trigger to start: 50+ signups with ≥5 asking
for paid features.

**Success criteria:**
- [ ] Google SSO signup/login works alongside email magic-link
- [ ] Stripe subscription checkout succeeds; webhook flips user to paid plan
- [ ] Paid plan removes 5-question cap; free plan enforces it
- [ ] Custom rule engine evaluates user-authored rules (platform pair, market category, threshold) and alerts when matched
- [ ] Downgrade/cancel flow restores free-tier limits without data loss
- [ ] Paid tier never subsidizes Wire credits — billing is for product features only

### Phase 4 — v2.5: Auto-execution (Power tier)
Power tier ($99/mo). User connects Kalshi REST API key and Polymarket via
wallet signature. Capital-management rules govern position size. Trigger to
start: paid-tier MRR > $1k for 2 consecutive months.

**Success criteria:**
- [ ] User securely stores Kalshi API key and Polymarket wallet signature (encrypted at rest, same pattern as the Anakin key)
- [ ] Capital-management rules (max-position, max-daily-loss, per-question cap) enforced before any order
- [ ] End-to-end test executes a paired YES/NO order on Kalshi and Polymarket against testnet/sandbox
- [ ] Funds are never custodied — every order routes through the user's connected account
- [ ] Kill switch disables auto-execution immediately for a user without losing in-flight settlement tracking

## Non-goals
- No mobile app in v1 — responsive web only
- No multi-user/team accounts in v1 — single-user emails only (multi-user lands in Phase 2)
- Never custody user funds — auto-execution always uses the user's own platform accounts
- Never pay for Wire credits on behalf of users — every Wire call is billed to the user's own Anakin key
- Never scrape platforms outside Anakin's catalog
- No content, opinion, or market-making advice — pure data product
- Never guarantee profitability — UI must always show "arb ≠ profit; slippage and fees may eat spread"

## Constraints
- Stack: Architect chooses (no preference). Magic-link auth + free hosting is a hard requirement; if Vercel + NextAuth + Resend + Neon/Supabase free tiers don't fit, the Architect must document why before picking paid alternatives.
- Deployment: Architect chooses, free tier preferred
- Polish bar (Phase 1): demo-ready — clean enough to show someone
- Credentials: Bring-Your-Own-Credentials. The app never holds shared Anakin/Kalshi/Polymarket credentials. User-supplied keys are encrypted at rest and used only for that user's calls.
- Data sourcing: cross-platform market data flows exclusively through Anakin Wire actions (kl_events, mm_search_markets, pm_get_events, rh_get_events) using the authenticated user's Anakin key
- Disclaimers: required on every spread view from Phase 1 onward

## Stakeholders
You — single decision-maker.
