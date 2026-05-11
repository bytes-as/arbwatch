# Sprint 3 — Retro

## Stats
- Stories shipped: 4 / 4 (100%)
- Tasks dispatched: 9 (including 1 bundled hardening dispatch + 1 orchestrator-direct implementation)
- Avg attempts per task: ~1.3 (one frontend task looped twice on the zeus:frontend agent before being closed via orchestrator verification)
- Blockers escalated to human: 0
- Roles exercised: qa (×3), backend (×4 + bundle), frontend (looped → orchestrator-direct)
- New tests: ~125+ across watched/matching/cron/prod-guard

## What went well
- **Architect's Sprint-1 field-mapping ADR held up under real fixtures.** The midpoint-of-YES-bid/ask convention with last-trade fallback worked unchanged against all 4 platforms once fixtures were recorded. No ADR edits needed.
- **Bundled hardening dispatch worked.** Four small follow-up tasks plus an unrelated auth regression investigation all closed in a single backend dispatch. Roughly 8 minutes vs the 30+ for 4 separate dispatches.
- **Probe-on-paste rounds out criterion 3.** The Sprint-2 UX gap (dashboard banner stuck after paste) is gone — the probe runs inline and the status flips to `ok` before the response returns.
- **`question_matches` schema landed with CASCADE early.** When the watched-DELETE cascade was added, it was a no-op for `task-watched-backend` (table didn't exist yet), then automatically activated when `task-matching-impl` created the table with the right FK. No retro-cascade migration needed.
- **Workspace project split fixed cross-suite pollution.** The auth Vitest regression turned out to be a setup-file interaction (cron + watched changes affected the shared in-process server). Giving auth its own Vitest workspace project isolated the harness cleanly.

## What to watch
- **zeus:frontend agent loops on Playwright-validated tasks.** The watched-frontend dispatch looped twice (interrupted both times by the user). On inspection, the agent had actually written complete, contract-correct code in earlier attempts — it was looping while trying to run Playwright tests (which need a live server). When the orchestrator implemented Sprint 4's dashboard table, take one of two approaches: (a) explicitly tell the frontend agent to stop after writing code without running Playwright, OR (b) skip the agent and write directly. Don't expect the frontend agent to self-verify Playwright tests in-loop.
- **Test-runner output count fluctuates.** Sprint reports cite "X/Y tests pass" for slightly different `Y`s depending on which workspace is invoked. The total is ~250+ when including all suites + Playwright. The orchestrator should record "tests-in-this-suite" not "tests-total" to avoid the appearance of mysterious test count changes.
- **Live-server verification debt accumulating.** Sprint 2 deferred 1 Playwright skip; Sprint 3 added 13 watched Playwright tests not verified against a live server. Total Playwright debt: ~13-14 tests that should be re-run before Phase 1 close. A "Phase 1 close: live-server demo + Playwright run-through" task in Sprint 5 will catch any latent issues.
- **Wire fixture mapping has a Sprint-2 architect TODO.** ADR-0002 §"Field mapping per platform" notes some paths need verification against live Wire payloads. The QA dispatch verified paths against the *recorded* fixtures (which the QA agent authored), but not against live Wire. This is a meta-circular verification. Real-world correctness still depends on Anakin's actual Wire payloads matching the convention — flag for the user before Phase 1 close.

## Lessons for Sprint 4
- **Sprint 4 is the dashboard table + email alerts sprint.** Dashboard must render spreads, deeplinks, color rules, freshness affordance — all of this depends on `spread_snapshots` (Sprint 3) and `question_matches` (Sprint 3). The data is there; this sprint is rendering it. Easier than Sprint 3's heavier backend lift.
- **Plan the email-alert dispatch carefully.** Resend transport is already wired (Sprint 2 magic-link); the new piece is the hysteresis rule (no duplicate alerts until threshold re-crosses), the alert dispatch path (probably another cron route or invoked from within the existing spread cron), and the email template with deeplinks + disclaimer.
- **Frontend dispatches for Sprint 4 should constrain the agent's verification step.** Either explicitly: "write the code, mark complete, do not loop on Playwright." Or write directly via the orchestrator.
- **Disclaimer enforcement (Sprint 5)** is partly already in the DashboardClient — the spread-view disclaimer is rendered today even though no spreads are visible. Sprint 5's task collapses to test-coverage assertions + email template inclusion.
