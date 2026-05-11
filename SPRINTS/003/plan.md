# Sprint 3 — Watched questions + matching + cron + hardening

**Phase:** phase-1-mvp
**Opened:** 2026-05-11

## Goal
Add the data engine that makes Phase 1 useful: free-text watched questions, cross-platform matching via Wire actions, and a 5-min cron that refreshes spreads. Bundle the four Sprint-2 security hardening tasks alongside since they're short and the same backend context applies.

End-of-sprint demo: signed-in user can add up to 5 watched questions; backend matches each across Kalshi/Manifold/Polymarket/Robinhood via Wire fixtures; spreads refresh on a 5-min interval; the dashboard banner clears on a successful probe-on-paste; production app fails fast on an all-zero encryption key.

## Phase context
Phase 1 has 10 success criteria; Sprint 2 closed 5. This sprint targets:
- Criterion 3 (key-error banner end-to-end) — completes via probe-on-paste (F4)
- Criterion 4 (matching across 4 platforms for ≥3 of 5 seeded queries)
- Criterion 5 (5-min cron + spread = max−min formula)

Criteria 6 (email alerts), 7 (dashboard table), 10 (disclaimer) land in Sprints 4-5.

## Committed stories (4)

### 1. story-watched-questions-crud (P0)
Add / list / remove watched questions with a 5-cap. 3 tasks: qa-test → backend → frontend.

### 2. story-cross-platform-matching (P0)
Free-text query → markets on all 4 platforms via Wire actions, using each user's Anakin key. QA task includes recording Wire fixtures per ADR-0002 and verifying `lib/wire/mapping.ts` per-platform JSON paths. 2 tasks: qa-test (fixtures + assertions) → backend (matching pipeline).

### 3. story-spread-cron (P0)
Every-5-min background job: fetch implied_yes_prob per platform, compute spread = max − min, record last_updated. Skip users with `key-missing` / `key-invalid` / `quota-exhausted`. 2 tasks: qa-test → backend.

### 4. story-sprint-2-hardening (P1)
Bundle of 4 short hardening tasks from the Sprint-2 security reviews. Likely single backend dispatch covering all four (F2 CSRF env flag, F3 middleware `/api/me` matcher, F4 probe-on-paste + F5 test reconciliation, F6 zero-key prod guard).

## Dispatch plan (maxParallel=2)
- Wave 1 (parallel): qa(task-watched-test) ‖ qa(task-matching-test)
- Wave 2 (parallel): qa(task-cron-test) ‖ backend(task-watched-backend)
- Wave 3 (parallel): backend(task-matching-impl) ‖ frontend(task-watched-frontend)
- Wave 4 (parallel): backend(task-cron-impl) ‖ backend(hardening-bundle: F2+F3+F4+F5+F6)

8 dispatches across 4 waves. Waves are guidance; orchestrator may resequence.

## Out of scope for Sprint 3
- Dashboard table rendering watched questions with spreads + deeplinks — Sprint 4.
- Email alerts — Sprint 4-5.
- Disclaimer enforcement on every spread view — Sprint 5.
- Live Wire calls — Phase 1 stays in `WIRE_MODE=fixtures` end-to-end; live mode is structural-only in `lib/wire/client.ts`.
