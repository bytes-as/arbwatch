# Sprint 1 — Review

**Phase:** phase-1-mvp
**Opened:** 2026-05-10
**Closed:** 2026-05-10

## Goal
Lay the architectural and UX foundations so subsequent sprints can build to spec without ambiguity.

## Shipped
- **story-stack-decision** — `docs/architecture/0001-stack.md`
  Stack: Next.js 15 (App Router) + NextAuth v5 Email Provider + Drizzle ORM (SQLite dev / Neon Postgres prod) + Vercel Cron + Resend + `@noble/ciphers` AES-256-GCM. Deploy on Vercel Hobby. Every chosen service fits a free tier at MVP scale.
- **story-wire-integration-adr** — `docs/architecture/0002-wire-integration.md`
  Typed fetch wrapper at `lib/wire/client.ts`; AES-GCM decrypt-on-demand per call (AAD = user.id); one-retry + 6s per-user budget under an 8s global AbortController; `WIRE_MODE=fixtures` env switch reads `tests/fixtures/wire/<action>/<slug>.json`; midpoint-of-YES-bid/ask field-mapping convention with last-trade fallback; three-class error taxonomy (`key-missing` | `key-invalid` | `quota-exhausted`) tied to a `users.anakin_key_status` enum column.
- **story-onboarding-design** — `docs/design/auth-and-onboarding.md`
  4-screen flow (sign-in → check-email → key-paste → dashboard handoff), 8 error/edge states, full copy strings, ASCII layouts, per-element keyboard/ARIA notes.
- **story-dashboard-design** — `docs/design/dashboard.md`
  Single-table layout, 8 states (empty, loading, populated, cap-reached, stale, 3× key-error, add-pending), disclaimer in both sub-header and footer, `aria-live="assertive"` banner for key-error classes, semantic color/treatment rules.

## Carried
None. Sprint 1 was a single-batch ADR-and-design sprint with no implementation; nothing slipped.

## Forward-phase gates captured in DECISIONS.log
- Phase 3: Vercel Pro upgrade required before enabling Stripe (Hobby disallows commercial use).
- Phase 2: re-evaluate Inngest vs in-process cron when active users > 5 OR cron handler p95 > 6s.
- Phase 4: provision a long-running worker (Fly.io / Railway) for auto-execution loops; Vercel function limits don't fit.

## Backlog amendments applied
- `task-key-backend` DoD extended with the `users.anakin_key_status` enum column (per ADR-0002).
- `task-matching-test` DoD extended with the Wire-fixture recording prerequisite + `lib/wire/mapping.ts` verification step.
