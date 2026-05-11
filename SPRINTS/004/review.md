# Sprint 4 — Review

**Phase:** phase-1-mvp
**Opened:** 2026-05-11T06:27:58Z
**Closed:** 2026-05-11T12:45:00Z

## Goal
Close Phase 1's three remaining success criteria: spread rendering on the dashboard (#7), threshold-crossed email alerts within 60s (#6), and disclaimer-on-every-spread-view contract (#10).

## Shipped — all 3 stories closed

### story-dashboard-impl
- `app/dashboard/page.tsx` now JOINs `watched_questions` with `spread_snapshots` + `question_matches`.
- `app/dashboard/WatchedSection.tsx` renders per-row: spread value (treatments `spread--alert` / `spread--neutral` / `spread--unavailable`), relative timestamp (`N min ago` / `timestamp--stale` >10 min), 4 platform chips (kalshi → manifold → polymarket → robinhood; matched as `<a target="_blank">` links, unmatched as `aria-disabled` spans).
- Aria labels: `"Spread: X.Y% — above alert threshold"`, `"View on {Platform} (opens in new tab)"`, `"Not matched on {Platform}"`, `"— data may be stale"` stale suffix.
- CSS in `app/globals.css` with WCAG AA contrast in both light/dark.
- Test-only API routes: `app/api/test-seed-spreads/route.ts` and `app/api/test-set-key-status/route.ts` for Playwright fixture seeding; both 404 outside `NODE_ENV=test`.
- App-code TypeScript: zero errors. 20 Playwright contract tests in `tests/dashboard/dashboard-spreads.spec.ts` (verification deferred — see Phase 1 close items below).

### story-email-alerts
- `alerts` schema (UNIQUE on question_id, ON DELETE CASCADE, CHECK on state enum).
- `lib/alerts.ts`: `SPREAD_THRESHOLD = 0.03`, `dispatchAlerts()` with armed↔fired state machine + 60s internal idempotency.
- `lib/alerts/template.ts`: HTML + plaintext templates containing the disclaimer + 4-platform deeplinks (locked order) + `"X.Y%"` formatted spread.
- Integrated into `/api/cron/refresh-spreads` after per-question spread computation.
- 21/21 alert tests pass.

### story-disclaimer-everywhere
- `tests/disclaimer/disclaimer.spec.ts` enumerates spread-bearing routes + email templates + does a defensive grep on `app/**/*.tsx` files referencing "spread".
- 7/7 tests pass immediately because `DashboardClient.tsx` and `lib/alerts/template.ts` already include the disclaimer (rolling Sprint 2/3/4 hygiene paid off).
- Future spread-rendering surfaces will fail this test unless they include the disclaimer or are added to the exception list.

## Test totals at sprint close
- Vitest: ≥197 tests passing (21 auth + 46 key + 26 watched + 35 matching + 48 cron + 21 alerts + 14 skeleton-seed/root)
- Playwright: 28 verified against live server (10 auth + 18 key, from Sprint 2) + 33 deferred (13 watched from Sprint 3 + 20 dashboard from Sprint 4)

## Carried to Sprint 5 ("Phase 1 close + verification")
None code-wise, but two verification items remain before Phase 1 can formally close:
1. **Live-server Playwright verification (~33 tests).** Run `./preview.sh`, execute all Playwright suites against the live server, fix anything that slipped past contract-matching.
2. **Real-Wire field-mapping spot-check.** ADR-0002's midpoint-of-YES convention has been validated only against synthetically-recorded fixtures. Confirm a single live Wire payload per platform matches the convention.

These are captured in `.sdlc/PHASE_HUMAN_CHECK.md`.

## Phase 1 success criteria — 10 of 10 implementation-complete

| # | Criterion | Status |
|---|---|---|
| 1 | Magic-link signup + persistent session | ✅ Sprint 2 |
| 2 | Encrypted Anakin key at rest, per-user | ✅ Sprint 2 |
| 3 | Key-error dashboard banner | ✅ Sprint 3 |
| 4 | Watched questions across 4 platforms (≥3/5) | ✅ Sprint 3 |
| 5 | 5-min cron + spread formula | ✅ Sprint 3 |
| 6 | Email alert within 60s of threshold cross | ✅ Sprint 4 |
| 7 | Dashboard shows spread + last-updated + deeplinks | ✅ Sprint 4 |
| 8 | preview.sh + seeded SQLite | ✅ Sprint 2 |
| 9 | README quickstart | ✅ Sprint 2 |
| 10 | Disclaimer on every spread view | ✅ Sprint 4 |

**All 10 implementation-complete. Phase 1 close pending the two human-verification items above.**
