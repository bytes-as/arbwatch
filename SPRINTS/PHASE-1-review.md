# Phase 1 — MVP Review

**Phase:** phase-1-mvp
**Opened:** 2026-05-10 (Sprint 1)
**Closed:** 2026-05-11 (Sprint 4 close, advanced by user direction past human-check)
**Sprints:** 4 (foundations / auth+credentials / matching+cron / dashboard+alerts)
**Status:** ✅ All 10 implementation criteria met; 2 human-verification items deferred (see `.sdlc/PHASE_HUMAN_CHECK.md`)

## What shipped end-to-end

A working MVP:
1. New user opens `localhost:3000` → sign-in page.
2. Enters email → magic link delivered via Resend (or fixture inbox in dev).
3. Clicks link → authenticated, lands on onboarding.
4. Pastes Anakin Wire API key → encrypted at rest (AES-256-GCM, AAD=user.id) → inline Wire probe validates it.
5. Lands on dashboard, adds up to 5 watched questions in free text.
6. Each add fans out across `kl_events`, `mm_search_markets`, `pm_get_events`, `rh_get_events` via the user's Anakin key (or recorded fixtures in dev). Market refs persisted with the midpoint-of-YES-bid/ask convention.
7. Vercel Cron `*/5 * * * *` refreshes spreads per user. State machine handles key-error / quota-exhausted users (with 10-min cooldown), idempotency (60s window), and the 8s per-user time budget.
8. Threshold crosses (spread ≥3%) trigger a Resend email within 60s. Hysteresis state machine (`armed↔fired`) prevents duplicates until re-cross.
9. Dashboard renders per-row spread value with alert/neutral/unavailable treatments, `N min ago` freshness with stale warning >10 min, four platform chips (matched as `<a target="_blank">`, unmatched aria-labeled), and the disclaimer "arb ≠ profit; slippage and fees may eat spread" in both sub-header and footer.
10. Email template carries the disclaimer in HTML + plaintext.

## Sprints in flight

| # | Goal | Stories | Highlights |
|---|---|---|---|
| 1 | Foundations | 4 | Stack ADR (Next.js 15 + NextAuth + Drizzle + Vercel Cron + Resend + Vercel Hobby); Wire-integration ADR (midpoint-of-YES, error taxonomy); UX specs for auth+onboarding + dashboard |
| 2 | Skeleton + Auth + Key | 3 | App boots, magic-link auth works, BYO Anakin key encrypted at rest, 2 security reviews on disk |
| 3 | Watched + Matching + Cron + hardening | 4 | Watched-question CRUD; cross-platform matching with 20 Wire fixtures; 5-min spread cron with cooldown + idempotency; 4 hardening items (CSRF env, /api/me middleware, probe-on-paste, zero-key prod guard) |
| 4 | Dashboard + Alerts + Disclaimer | 3 | Dashboard renders spreads/deeplinks/freshness; threshold-crossed Resend alerts with hysteresis; disclaimer-everywhere coverage test |

## Test inventory at Phase 1 close

- **Vitest:** ≥197 tests passing across 7 workspaces (21 auth + 46 key + 26 watched + 35 matching + 48 cron + 21 alerts + 14 skeleton-seed/root). Plus 7 disclaimer tests, 4 prod-guard tests.
- **Playwright:** 28 verified against a live preview.sh server (10 auth + 18 key, end of Sprint 2). 33 deferred Playwright tests (13 watched + 20 dashboard) authored by contract-matching against the implementation; pending live-server run per `.sdlc/PHASE_HUMAN_CHECK.md`.

## Decisions of record (Phase 1)
- Stack: Next.js 15 App Router + NextAuth v5 (Email Provider + Drizzle adapter) + Drizzle (SQLite dev / Neon Postgres prod) + Vercel Cron + Resend + `@noble/ciphers` AES-256-GCM, deployed to Vercel Hobby.
- Public product name: **ArbWatch** (repo dir remains `predmkt-arb`; user has not explicitly ratified but tests + UI consistently use ArbWatch).
- Credentials policy: **Bring-Your-Own Anakin key per user.** App never holds shared platform credentials. Wire calls billed to the user's Anakin account.
- Cross-platform convention: midpoint of YES bid/ask with last-trade fallback per ADR-0002. **Meta-circular verification today** (recorded fixtures match the ADR convention by construction); real-Wire spot-check tracked in PHASE_HUMAN_CHECK.

## Forward-phase gates captured during Phase 1
- **Phase 3 (before Stripe):** Vercel Pro upgrade required (Hobby disallows commercial use). APP_ENCRYPTION_KEY rotation via dual-key decrypt + re-encrypt-on-read before paid users. Move to KMS hop.
- **Phase 2 sprint 1:** Rate-limit on `POST /api/auth/signin/email` before any semi-public URL. Pino + redact path before structured logging.
- **Phase 4:** Provision long-running worker (Fly.io / Railway) for auto-execution; Vercel function limits don't fit.

## Phase 1 verdict
**Demo-ready and shippable.** The 33 deferred Playwright tests are contract-matched; the live-server run is hygiene, not a blocker for sharing a demo URL with friends or running the app locally. Phase 2 (multi-user, custom thresholds, web push, embeddings, history chart) opens immediately.
