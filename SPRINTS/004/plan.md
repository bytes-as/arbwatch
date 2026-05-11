# Sprint 4 — Phase 1 closer

**Phase:** phase-1-mvp
**Opened:** 2026-05-11

## Goal
Close Phase 1's three remaining success criteria: dashboard renders spreads/deeplinks/freshness (#7); email alerts within 60s of threshold cross with hysteresis (#6); disclaimer appears on every spread view (#10).

## Phase context
Phase 1 has 10 success criteria; Sprint 3 closed 7. This sprint targets the remaining 3, after which Phase 1 closes and the orchestrator can open Phase 2 (multi-user + smarter matching).

## Committed stories (3)

### 1. story-dashboard-impl (P0)
Render the watched-questions table with: per-row spread value (color rule: green when >3%, muted when null/single-platform, neutral otherwise), last-updated timestamp ("3 min ago"), platform deeplinks (4 chips per row, "no match" state for missing platforms), stale-data state when last_updated > 10 min, key-error banner already wired from Sprint 2. Tasks: qa-test → frontend-impl.

### 2. story-email-alerts (P0)
When `spread_snapshots` rolls a value across the user's threshold (default 3%), send a templated Resend email within 60s. Hysteresis: no duplicate alert until the spread drops below threshold and re-crosses. Email contains the watched question text + per-platform deeplinks + the mandatory disclaimer. Tasks: qa-test → backend-impl.

### 3. story-disclaimer-everywhere (P0)
Test-coverage assertion: every surface that renders a spread value must include the disclaimer string "arb ≠ profit; slippage and fees may eat spread". The dashboard already includes it (Sprint 3); this story enforces the contract across all routes + email templates. Tasks: qa-test (the test IS the implementation — it locks the contract; any future spread surface that omits the disclaimer fails this test).

## Dispatch plan (maxParallel=2)
- Wave 1 (parallel): qa(task-dashboard-test) ‖ qa(task-alerts-test)
- Wave 2 (parallel): qa(task-disclaimer-test) ‖ backend(task-alerts-impl)
- Wave 3: frontend(task-dashboard-impl) — solo, with explicit "no Playwright self-verification" guardrail per Sprint 3 retro.

5 dispatches across 3 waves.

## Out of scope for Sprint 4
- Live-server Playwright debt verification — moved to a Sprint 5 "Phase 1 close" task.
- Real-Wire field-mapping verification — same.
- Anything Phase 2+ (multi-user, embeddings, web push, Stripe, auto-execution).
