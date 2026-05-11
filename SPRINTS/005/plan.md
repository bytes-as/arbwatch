# Sprint 5 — Phase 2 sprint 1

**Phase:** phase-2-v1.5 — Multi-user + smarter matching
**Opened:** 2026-05-11

## Goal
Open Phase 2 with three lighter stories before tackling the heavier embedding + web-push work in Sprint 6:
1. Multi-user signup + cross-user isolation hardening (criterion 1).
2. Per-question custom thresholds (criterion 2).
3. 7-day spread history + per-row sparkline (criterion 5).

End-of-sprint: two real human users can sign up, set per-question thresholds different from the default 3%, and see a 7-day spread sparkline on each row.

## Committed stories (3)

### 1. story-multiuser-isolation-tests
Real magic-link signup creates a fresh user row (currently only the fixture user has a path). Cross-user isolation tests. Test-route gating from Sprint 4 retro folded in. 3 tasks: qa-test → backend-signup → backend-test-route-gating.

### 2. story-custom-thresholds
Schema column (`watched_questions.threshold` real nullable), PATCH endpoint, dashboard inline control, cron+alerts read per-question override. 3 tasks: qa-test → backend → frontend.

### 3. story-spread-history
Append-only `spread_history` table, retention pruning, `/api/watched/:id/history` endpoint, SVG sparkline per dashboard row. 3 tasks: qa-test → backend → frontend.

## Dispatch plan (maxParallel=2)
- Wave 1 (parallel): qa(task-multiuser-test) ‖ qa(task-thresholds-test)
- Wave 2 (parallel): qa(task-history-test) ‖ backend(task-multiuser-signup)
- Wave 3 (parallel): backend(task-test-route-gating) ‖ backend(task-thresholds-backend)
- Wave 4 (parallel): backend(task-history-backend) ‖ frontend(task-thresholds-frontend)
- Wave 5: frontend(task-history-frontend) — solo, with no-Playwright-loop guardrail.

11 dispatches across 5 waves.

## Out of scope for Sprint 5
- Web-push (Sprint 6).
- Embedding-based matching (Sprint 6).
- Live-server Playwright run for the 33 deferred Phase-1 tests (still tracked in PHASE_HUMAN_CHECK).
- Real-Wire field-mapping spot-check (tracked in PHASE_HUMAN_CHECK).
