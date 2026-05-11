# Changelog

All notable changes to ArbWatch (repo: `predmkt-arb`).

The project is structured in phases; each phase's notes summarize user-visible changes shipped in that phase.

## [Phase 1 — MVP] — 2026-05-11

**Status:** Implementation-complete. Live-server Playwright + real-Wire spot-check tracked in `.sdlc/PHASE_HUMAN_CHECK.md`.

### Added
- Email magic-link signup via NextAuth v5 + Resend. Persistent session (30-day cookie, HttpOnly + Secure-in-prod + SameSite=Lax).
- BYO Anakin Wire API key: paste during onboarding, rotate or remove from settings. Encrypted at rest with AES-256-GCM (AAD = user.id); decrypted only at the Wire call frame.
- Inline Wire probe on key-paste so `anakin_key_status` transitions to `ok`/`key-invalid`/`quota-exhausted` immediately and the dashboard banner reflects reality.
- Watched questions: add free-text queries (up to 5), list, remove with inline confirmation. Counter "X / 5 watched".
- Cross-platform matching against Kalshi, Manifold, Polymarket, and Robinhood Prediction Markets via Anakin Wire actions (`kl_events`, `mm_search_markets`, `pm_get_events`, `rh_get_events`).
- 5-min spread cron (Vercel Cron). Computes spread = max(implied_yes_prob) − min(implied_yes_prob) per question across matched platforms. Handles key-error / quota-exhausted users with a 10-min cooldown; 60s back-pressure idempotency.
- Threshold-crossed email alerts (default 3%) via Resend. Hysteresis state machine prevents duplicates until the spread drops below threshold and re-crosses. Email body includes per-platform deeplinks + the mandatory disclaimer.
- Dashboard: per-question spread value with semantic treatment (alert / neutral / unavailable), `N min ago` freshness with stale warning >10 min, four platform deeplink chips (matched as `<a target="_blank">`, unmatched aria-labeled).
- Mandatory disclaimer "arb ≠ profit; slippage and fees may eat spread" on every spread-bearing surface — dashboard sub-header + footer + email HTML + email plaintext — locked by a registry test that fails if a new spread surface omits it.
- Production guards: `APP_ENCRYPTION_KEY` all-zero fail-fast in production; explicit `SKIP_CSRF_CHECK` env var (not `NODE_ENV==test`); `/api/me` in the auth middleware matcher.
- Test scaffolding: 17 skeleton tests, 21 auth Vitest, 46 key (incl. prod-guard), 26 watched, 35 matching, 48 cron, 21 alerts, 7 disclaimer. 28 Playwright verified against live preview.sh; 33 contract-validated awaiting live run.

### Architecture
- Stack ADR pinned at `docs/architecture/0001-stack.md`: Next.js 15 (App Router) + NextAuth v5 + Drizzle (SQLite dev / Neon Postgres prod) + Vercel Cron + Resend + `@noble/ciphers`, deployed to Vercel Hobby (free tier).
- Wire-integration ADR at `docs/architecture/0002-wire-integration.md`: per-call credential injection with AAD = user.id; 1-retry + 6s per-user budget under 8s AbortController; `WIRE_MODE=fixtures` for local dev; midpoint-of-YES-bid/ask convention with last-trade fallback.
- Two security reviews on disk (`docs/security/auth-review.md`, `docs/security/credential-storage-review.md`). Both: **Pass — Phase 1 close unblocked.** 10 follow-ups tracked for Phase 2-3.

### Known gaps deferred to Phase 2-3
- Server-side rate-limit on magic-link request (Phase 2 sprint 1; risk: inbox-bomb / Resend quota exhaustion when URL is public).
- Pino logger + ADR-0002 redact path (Phase 2; risk: future structured logger could regress no-log invariant).
- `APP_ENCRYPTION_KEY` rotation + KMS hop (Phase 3; risk: rotating today invalidates every stored ciphertext).
- Live-server Playwright run for the 33 deferred tests (`.sdlc/PHASE_HUMAN_CHECK.md`).
- Real-Wire field-mapping spot-check (`.sdlc/PHASE_HUMAN_CHECK.md`).

---

[Phase 2 in progress — see SPRINTS/005+ for current sprint status.]
