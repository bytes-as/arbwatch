# Sprint 4 — Retro

## Stats
- Stories shipped: 3 / 3 (100%)
- Tasks dispatched: 5 (3 QA + 1 backend + 1 frontend with guardrail)
- Avg attempts per task: 1.0
- Blockers escalated: 0
- Looped dispatches: 0 (vs Sprint 3's 2 frontend loops — the explicit "no Playwright" guardrail fixed it)
- Roles exercised: qa (×3), backend (×1), frontend (×1)
- New tests: ~48 (20 dashboard Playwright + 21 alerts Vitest + 7 disclaimer)

## What went well
- **Explicit guardrail solved the frontend looping problem.** Sprint 3 retro flagged that `zeus:frontend` loops while trying to run Playwright against a live server. Sprint 4's dispatch added a literal `STRICT GUARDRAIL: Do NOT run Playwright tests. Do NOT start the dev server. Do NOT loop verifying.` block — and the agent completed cleanly in 4 minutes vs ~25 min looping. Encode this in the agent's system prompt for future sprints.
- **Disclaimer-everywhere story closed effortlessly.** Because Sprint 2/3 already wired the disclaimer in `DashboardClient.tsx` and Sprint 4's alert template included it from the start, the test file landed and immediately passed 7/7. The "test is the implementation" framing worked — the test is now a regression guard for any future spread-bearing surface.
- **Alert hysteresis encoded in a state machine, not ad-hoc conditions.** The QA brief locked the state transitions (`armed↔fired`); the backend implementer wrote them as explicit transitions, not "if-this-and-not-that" sprawl. State-machine semantics will survive the Phase 3 custom-rule-engine refactor.
- **Cross-sprint hygiene paid off.** Spring 3 left `spread_snapshots` + `question_matches` schemas + cron-computed snapshots already in place; Sprint 4 was rendering + alerting, not data engineering. Each sprint's groundwork enabled the next.

## What to watch
- **Playwright verification debt is now structural.** ~33 Playwright tests authored across Sprints 3-4 are not verified against a live server. They're contract-matching against the implementation, which is high-quality but not the same. Phase 1 cannot formally close until they're run. The user should plan a 30-min "preview.sh + run Playwright" session before declaring Phase 1 shipped.
- **Real-Wire field-mapping is still meta-circular.** ADR-0002 + recorded fixtures + tests-against-fixtures form a closed loop. A single real Wire payload per platform would close it. The orchestrator can't do this without live Anakin credentials.
- **Test-only API routes (`/api/test-seed-spreads`, `/api/test-set-key-status`) are a backdoor that depends entirely on `NODE_ENV !== "test"` returning 404 in production.** This is correct today (Vercel never sets `NODE_ENV=test`), but a future deploy or staging environment could accidentally enable them. The Sprint-2 security review pattern (F2 -> explicit `SKIP_CSRF_CHECK` env) suggests a similar fix: gate on an explicit `ENABLE_TEST_ROUTES=true` env var that's never set outside CI. Tracked as a Phase 2 hardening item below.

## Lessons for Phase 2
- **Multi-user isolation testing has a head start.** The auth Vitest workspace project (Sprint 3 5th item) already exercises 2 users in isolation. Phase 2's multi-user explicit testing builds on this — the harness pattern is in place.
- **Embedding matching (Phase 2)** can reuse the Wire fixture infrastructure. The `__default__.json` fallback + slug-aliasing pattern will extend cleanly to embeddings (compute an embedding for the user's free-text, find the nearest match per platform).
- **Web-push notifications (Phase 2)** can reuse the alerts state machine. The dispatch swap is `Resend → web-push transport`; everything else (hysteresis, idempotency, template-rendering) stays the same.

## New Phase 2 hardening items to track
- **Test-route gating.** Replace `NODE_ENV !== "test"` guard on `app/api/test-seed-spreads` and `app/api/test-set-key-status` with `ENABLE_TEST_ROUTES=true` env var. Severity: LOW. Phase: Phase 2 sprint 1 (alongside the existing F2 pattern).
