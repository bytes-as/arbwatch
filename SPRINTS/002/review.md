# Sprint 2 — Review

**Phase:** phase-1-mvp
**Opened:** 2026-05-10T20:07:40Z
**Closed:** 2026-05-10T23:55:00Z (in-session wall-clock; auto-mode sprint)

## Goal
Get the app booting via `./preview.sh` and let a fresh visitor complete the entire onboarding flow: request magic link → click email → land authenticated → paste Anakin Wire key → reach the empty dashboard.

## Shipped
All three committed stories closed.

### story-skeleton (Foundation)
- Next.js 15 App Router skeleton boots on Node 25 (localStorage polyfill added for Next.js dev-overlay compatibility).
- Drizzle schema with `users` (+ encrypted Anakin key columns + 4-value CHECK constraint) + `watched_questions` + NextAuth adapter tables.
- AES-256-GCM helper at `db/encryption.ts`, with `APP_ENCRYPTION_KEY` env-sourced and length-checked.
- `preview.sh` generates `.env` from `.env.example`, installs deps, runs migrations + seed, then `npm run dev` with FIFO-piped stdout that prints `http://localhost:3000` after Next.js prints `Ready in Xs`. SIGTERM propagates to the npm child. **Note:** user tweaked the `.env` hydration block post-write to allow harness override of `DATABASE_URL`.
- `README.md` with Quickstart, env-var table, project layout. Copy-pasteable in <60s.
- 17/17 skeleton tests pass.

### story-magic-link-auth (Auth)
- NextAuth v5 + Email Provider + Drizzle adapter + Resend transport.
- `/signin`, `/check-email`, `/dashboard` (placeholder) pages with UX-spec-locked copy and accessibility.
- Session cookies: HttpOnly, SameSite=Lax, Secure in production, 30-day max-age.
- Middleware redirects authenticated users from `/`, `/signin` → `/dashboard`.
- 21/21 Vitest + 10/10 Playwright auth tests pass.
- Security review (`docs/security/auth-review.md`): **Pass — Phase 1 close unblocked**, 4 follow-ups tracked.

### story-anakin-key-storage (Credentials)
- `POST/GET/DELETE /api/me/anakin-key` endpoints, session-gated, IDOR-defended.
- AES-256-GCM at rest with AAD = `user.id`.
- `lib/wire/client.ts` decrypts per-call with `_clientCache` typed for `cipherDigest` only (no plaintext retention).
- `/onboarding/anakin-key` and `/settings` pages; dashboard gates on `anakin_key_status` and surfaces the key-error banner.
- Probe-based status progression: POST does not write `status=ok` until a Wire probe confirms validity (Sprint 3 wires the inline probe call — currently the dashboard banner persists post-paste; tracked as F4).
- 42/42 Vitest + 18/19 Playwright key tests pass (1 explicit `test.skip()`).
- Security review (`docs/security/credential-storage-review.md`): **Pass — Phase 1 close unblocked**, 6 follow-ups tracked.

## Carried to Sprint 3
- Sprint 2 hardening epic (`epic-sprint-2-hardening`) — 4 short tasks bundling security-review follow-ups F2–F6.

## Forward-phase items captured
- Phase 2 hardening: F1 (server-side rate-limit on magic-link POST, MEDIUM); F3 (Pino + redact path before structured logging, LOW).
- Phase 3 (before Stripe): F1 (APP_ENCRYPTION_KEY rotation via dual-key decrypt + re-encrypt-on-read); F2 (KMS hop for encryption key).
- Pre-prod: F6 (all-zero-key fail-fast guard — already an epic-sprint-2-hardening task).

## Decisions captured
- Public product name = **ArbWatch** (designer-chosen in Sprint 1, mirrored in QA tests + UI strings). Repo dir name stays `predmkt-arb`. The user has not been explicitly asked to ratify this brand; flag at the next status checkpoint.

## Phase 1 success criteria status (10 criteria)
| # | Criterion | Status |
|---|---|---|
| 1 | Magic-link signup + persistent session | ✅ Sprint 2 |
| 2 | Anakin key encrypted at rest, scoped per user | ✅ Sprint 2 |
| 3 | Key-error dashboard banner | ⚠️ Banner exists; needs probe-on-paste wire-up (F4) to test the full lifecycle |
| 4 | Watched questions across 4 platforms (≥3/5 seeded) | ⬜ Sprint 3 |
| 5 | 5-min cron + spread formula | ⬜ Sprint 3 |
| 6 | Email alert within 60s of threshold cross | ⬜ Sprint 4-5 |
| 7 | Dashboard shows spread + last-updated + deeplinks | ⬜ Sprint 4 |
| 8 | preview.sh + seeded SQLite | ✅ Sprint 2 |
| 9 | README quickstart <60s | ✅ Sprint 2 |
| 10 | Disclaimer on every spread view | ⬜ Sprint 5 |

5 of 10 done. Sprints 3-5 remain.
