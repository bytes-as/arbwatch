# Sprint 3 — Review

**Phase:** phase-1-mvp
**Opened:** 2026-05-11T02:09:59Z
**Closed:** 2026-05-11T11:30:00Z

## Goal
Watched-question CRUD + cross-platform matching + 5-min spread cron + Sprint-2 security follow-ups.

## Shipped — all 4 stories closed

### story-watched-questions-crud
- `POST/GET/DELETE /api/watched` endpoints with 5-cap enforcement, per-user isolation, IDOR-defended.
- Dashboard UI: WatchedSection with add form, list, inline-confirmation remove, "X / 5 watched" counter, cap state, empty state, accessibility (aria-labels, role="status"/role="alert"/aria-live).
- 26/26 watched Vitest pass; Playwright contract written (verification deferred to live-server runs).

### story-cross-platform-matching
- `lib/wire/mapping.ts` (midpoint-of-YES with last-trade fallback per ADR-0002, per-platform JSON paths).
- `lib/matching.ts` with parallel Promise.allSettled fan-out across 4 Wire actions; per-user Anakin key scoping.
- `question_matches` schema (UNIQUE on `(question_id, platform)`, ON DELETE CASCADE).
- `POST /api/watched` invokes the matcher inline; graceful WireError handling.
- 20 Wire fixture files + 4 `__default__` fallbacks + `scripts/record-wire-fixture.ts` + `tests/fixtures/wire/README.md`.
- 35/35 matching Vitest pass.

### story-spread-cron
- `vercel.json` with `*/5 * * * *` cron entry.
- `app/api/cron/refresh-spreads/route.ts` — CRON_SECRET-gated, iterates users, skips key-error users (no Wire call), 8s AbortController, 1-retry, 60s idempotency window, 10-min quota cooldown.
- `spread_snapshots` schema (UNIQUE on question_id, ON DELETE CASCADE).
- `users.quota_exhausted_until` column for cooldown rule.
- 48/48 cron Vitest pass (cadence + formula + skip logic + cooldown + auth + idempotency).

### story-sprint-2-hardening (4 bundled tasks)
- **F2** — Replaced `NODE_ENV==='test'` CSRF skip with explicit `SKIP_CSRF_CHECK=true` env var (`.env.example` documents it).
- **F3** — Added `/api/me` to `middleware.ts` matcher.
- **F4+F5** — Wired inline Wire probe on key-paste; status transitions to `ok`/`key-invalid`/`quota-exhausted` based on probe result; reconciled `encryption.test.ts` Suite-1 assertion.
- **F6** — Production guard in `getKey()` throws on all-zero `APP_ENCRYPTION_KEY`; 4 new tests.
- **5th item** — Discovered auth Vitest regression (13/21 token-redemption tests failing post-cron-impl due to in-process server setup pollution); fixed by giving auth tests their own Vitest workspace project with the correct fetch intercept setup.

## Test totals at sprint close
- Vitest: ≥176 tests passing (21 auth + 46 key + 26 watched + 35 matching + 48 cron + 14 skeleton-seed/root + 4 prod-guard).
- Playwright: 10 auth + 18 key tests pass against a live server; 13 watched Playwright deferred to live-server verification.

## Carried to Sprint 4
None. Sprint 3 closed all committed work.

## Phase 1 progress: 7 of 10 success criteria done
| Criterion | Status | Sprint |
|---|---|---|
| 1. Magic-link signup + persistent session | ✅ | 2 |
| 2. Encrypted Anakin key at rest, per-user | ✅ | 2 |
| 3. Key-error dashboard banner | ✅ | 3 (probe-on-paste landed) |
| 4. Watched questions across 4 platforms (≥3/5) | ✅ | 3 |
| 5. 5-min cron + spread formula | ✅ | 3 |
| 6. Email alert within 60s of threshold cross | ⬜ | Sprint 4 |
| 7. Dashboard shows spread + last-updated + deeplinks | ⬜ | Sprint 4 (CRUD UI exists; spread rendering pending) |
| 8. preview.sh + seeded SQLite | ✅ | 2 |
| 9. README quickstart | ✅ | 2 |
| 10. Disclaimer on every spread view | ⬜ | Sprint 5 (partial — disclaimer copy already in DashboardClient + footer) |

Three criteria left: dashboard table with spreads/deeplinks (Sprint 4), email alerts (Sprint 4-5), disclaimer enforcement coverage (Sprint 5).
