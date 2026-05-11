# ADR 0001 — Stack selection for Phase 1 MVP

Date: 2026-05-11
Status: Accepted

## Context
PROJECT.md mandates: free-tier hosting, magic-link email auth, BYO-Anakin-key
encrypted at rest, a 5-minute spread-refresh cron, demo-ready polish, and a
schema that already speaks `users` even though Phase 1 is single-user. The
constraint reads literally: "if Vercel + NextAuth + Resend + Neon/Supabase free
tiers don't fit, the Architect must document why before picking paid alternatives."
The maintainer is new to Vercel and wants batteries-included auth so magic-link
is not a custom build. preview.sh must boot against a seeded SQLite with 3 test
questions + 1 fixture user in <60s. Phases 2-4 add multi-user, web push, Stripe,
Google SSO, and auto-execution against Kalshi REST + Polymarket Polygon.

## Options considered

### Web framework + runtime
1. **Next.js (App Router) on Vercel, Node runtime.** Batteries-included
   auth via NextAuth, first-class Vercel Cron, large ecosystem, the maintainer's
   stated on-ramp.
2. **SvelteKit on Vercel.** Lighter, faster DX, but NextAuth equivalent
   (Auth.js for SvelteKit) is younger and the magic-link Email Provider story
   is less polished. Forces a custom build the maintainer wants to avoid.
3. **Bun + Hono on Fly.io / Railway.** My usual default. Faster runtime, but
   no free Vercel-Cron equivalent, no NextAuth, and the maintainer pays the
   "new platform" tax twice (Bun + Fly). Violates the "new to Vercel, favor
   batteries-included" steer.

### Database
1. **Neon Postgres (free tier) for prod, SQLite for dev/preview.sh.** Drizzle
   ORM speaks both via dialect switch; schema portable.
2. **Supabase Postgres.** Bundles auth + storage we don't need; auth bundle
   conflicts with NextAuth choice. More surface area than required.
3. **Turso (libSQL).** SQLite end-to-end; tempting for preview.sh parity but
   Phase 4 capital-management + ledger-style writes prefer Postgres semantics
   (row-level locks, JSONB, partial indexes).

### Background scheduler (5-min cadence)
1. **Vercel Cron.** Native, free on Hobby (max 2 cron jobs, minimum cadence
   1 min on Hobby in 2026), invokes a route handler. One job that fans out
   per-user fits within the limit.
2. **Inngest free tier.** Better for fan-out + retries, but adds a vendor
   and an SDK for v1; overkill at ≤50 users.
3. **GitHub Actions cron.** Free but unreliable cadence (5-15 min jitter
   documented), and tying production refresh to a CI runner is a smell.

### Email transport
1. **Resend free tier.** 3,000 emails/month, 100/day, native NextAuth Email
   Provider adapter. React Email for templating ships from same author.
2. **Postmark / SendGrid free.** Lower limits or trial-only; no tighter
   integration than Resend for our case.

### Secret encryption (Anakin key column)
1. **`@noble/ciphers` AES-256-GCM with a server-held `APP_ENCRYPTION_KEY`
   env var (32 bytes, base64).** Per-row random nonce, AAD = `user_id`,
   stored as `nonce||ciphertext||tag` in a single `bytea` column. Audited,
   pure-JS, zero-dep, runs on Vercel Node runtime.
2. **libsodium-wrappers (`crypto_secretbox`).** Equally fine; heavier WASM
   bundle, slower cold start on Vercel. Functionally equivalent to (1).
3. **Vercel KMS / AWS KMS.** Right answer at scale; not free, and overkill
   for v1's threat model (the env var is the trust root either way until
   we add a KMS hop).

### Deploy target
1. **Vercel Hobby.** Matches the framework + cron + maintainer-onboarding
   choice. Free.
2. **Fly.io / Railway.** More flexible runtime (Bun, persistent processes)
   but no free cron, and pulls us off the maintainer's stated path.

## Decision
**Next.js 15 (App Router) + NextAuth v5 (Auth.js) Email Provider + Drizzle ORM
(SQLite dev / Neon Postgres prod) + Vercel Cron + Resend + `@noble/ciphers`
AES-256-GCM, deployed to Vercel Hobby.**

One-sentence reason: it is the only stack where every Phase-1 requirement
(magic-link, 5-min cron, encrypted BYO key, SQLite-seedable preview.sh, free
hosting) lands inside an officially-supported free tier with a single platform
to learn.

### Locked-in specifics
- **Runtime:** Node 20 on Vercel (not Edge — `@noble/ciphers` + Drizzle Postgres
  driver are simpler on Node, and cron handlers run Node by default).
- **DB driver:** `better-sqlite3` for dev, `@neondatabase/serverless` for prod.
  Drizzle config switches on `DATABASE_URL` scheme.
- **Sessions:** NextAuth database sessions (not JWT) — required for magic-link
  single-use semantics and for the "session persists across browser restart"
  success criterion (cookie max-age = 30 days).
- **Cron:** one Vercel Cron entry at `*/5 * * * *` hitting
  `/api/cron/refresh-spreads`, authenticated by `CRON_SECRET` header. The
  handler iterates active users; per-user Wire fan-out is in-process for v1
  (Phase 2 moves fan-out to Inngest if ≤50-user budget is exceeded).
- **Encryption key:** `APP_ENCRYPTION_KEY` (32 random bytes, base64) in Vercel
  env. Stored ciphertext column layout: `nonce(12) || ciphertext || tag(16)`.
  AAD = `user.id` to bind ciphertext to its row.
- **Email templates:** React Email components, versioned under
  `emails/` (e.g. `emails/spread-alert.v1.tsx`). Template version recorded on
  every send for audit.
- **Schema, day one:** `users(id, email, created_at, anakin_key_ct,
  anakin_key_status)`, `watched_questions(id, user_id, query_text, …)`,
  `market_matches`, `spread_snapshots`, `alert_dispatches`. Multi-user-ready
  even while Phase 1 ships single-user UX.

## Free-tier budget (≤50 users at MVP scale)
| Service       | Free-tier limit (2026)                  | MVP usage (50 users)                              | Headroom   |
|---------------|------------------------------------------|---------------------------------------------------|------------|
| Vercel Hobby  | 100 GB bandwidth, 100k function invokes/day, 2 cron jobs | ~14k cron invokes/mo (1 cron × 288/day × 30) + light dashboard traffic | ~99% free  |
| Vercel Cron   | 1-min minimum cadence, 2 jobs            | 1 job at 5-min                                    | 1 job free |
| Neon Postgres | 0.5 GB storage, 191.9 compute-hours/mo   | <50 MB schema, intermittent queries               | ample      |
| Resend        | 3,000 emails/mo, 100/day                 | ≤50 magic links/day + alerts (worst case 50×5=250 alerts/day) | tight on alert-storm days; degrade gracefully (see Consequences) |
| `@noble/ciphers` | n/a (lib)                             | n/a                                               | n/a        |

Every chosen service fits its free tier at MVP scale. Resend is the tightest;
the alert dispatcher must dedupe via hysteresis (already a Phase-1 requirement
in `story-email-alerts`) so the daily ceiling is never approached in practice.

## Consequences

**Easier**
- Magic-link is `EmailProvider({ server, from })` plus a Drizzle adapter — no
  custom token table, no custom expiry logic.
- preview.sh is `DATABASE_URL=file:./.preview.db drizzle-kit push && bun run
  scripts/seed.ts && next dev` — SQLite means no Docker, no Postgres install.
- Vercel Cron + a single route handler covers the 5-min refresh with zero
  infra; the handler is just a function the backend agent writes.
- Phase 3 Stripe and Google SSO drop in: NextAuth has first-class
  GoogleProvider; Stripe webhook is just another route handler.

**Harder / locked-in**
- We are on the Node runtime, not Edge — slightly slower cold starts on
  rarely-hit routes. Acceptable; the dashboard is authenticated and warm.
- Vercel Hobby disallows commercial use once we monetize. **Phase 3 trigger
  (Stripe billing) requires upgrading to Vercel Pro ($20/mo) or migrating
  off Vercel.** Flagged as a follow-up story.
- Resend's 3k/mo cap will bind before user-count does; Phase 2 (web push)
  is the natural pressure release.
- Drizzle dialect switch SQLite↔Postgres requires schema discipline: no
  Postgres-only types in Phase 1 (no JSONB, no arrays, no partial indexes).
  Phase 4 ledger work will want JSONB; revisit then.

**Forward path**
- *Phase 2 (multi-user, web push):* `users` table is already multi-tenant;
  per-user Wire scoping is enforced at the encryption boundary (AAD = user.id).
  Web push uses the Web Push Protocol with VAPID keys — no vendor; fits free.
  If per-user cron fan-out exceeds Vercel function-duration budget (10s on
  Hobby, 60s on Pro), move to Inngest free tier (50k steps/mo).
- *Phase 3 (Stripe + Google SSO):* NextAuth GoogleProvider added alongside
  EmailProvider; users table grows `plan`, `stripe_customer_id`,
  `stripe_subscription_id`. Stripe webhook = one new route handler.
  Vercel Pro upgrade required at this gate (commercial-use clause).
- *Phase 4 (auto-execution):* Same encryption pattern (`@noble/ciphers`,
  per-user AAD) extends to Kalshi REST keys and Polymarket wallet
  signatures — new columns on `users`, no new crypto. Long-running execution
  workers will not fit Vercel function limits; plan to add a worker on
  Fly.io or Railway at that gate, talking to the same Neon DB.

## Follow-up stories the orchestrator should add
1. *Phase 3 gate:* "Vercel Pro upgrade or migrate off Vercel before enabling
   Stripe checkout" — blocks `epic-billing-stripe`.
2. *Phase 2 gate:* "Evaluate Inngest vs in-process fan-out once active users
   > 50 or cron handler p95 > 8s" — blocks `epic-multiuser-isolation` if hit.
3. *Phase 4 gate:* "Provision a long-running worker (Fly.io / Railway) for
   auto-execution; Vercel function limits do not fit order-management loops."
