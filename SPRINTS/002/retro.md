# Sprint 2 — Retro

## Stats
- Stories shipped: 3 / 3 (100%)
- Tasks dispatched: 13 (including 1 synthetic QA fix and 1 absorbed task)
- Avg attempts per task: ~1.1 — one task (`task-key-backend`) returned `review_requested` rather than `blocked`, with a precise diagnosis the QA agent fixed in one line.
- Blockers escalated to human: 0
- Roles exercised: qa (×3), backend (×3), frontend (×2), tech_writer (×1), security (×2), devops (absorbed)

## What went well
- **QA-first cadence held.** Each implementer dispatch had failing tests in hand before writing code, which kept the contract tight. The auth-frontend dispatch in particular landed cleanly because the 10 Playwright tests were authored before any UI work.
- **Review-requested handoff worked.** `task-key-backend` returned `review_requested` with a one-line diagnosis ("Suite-1 afterAll doesn't reset `db = undefined`"). The synthetic QA task fixed it in one edit. No retry, no escalation. The pattern is healthy.
- **Cross-doc traceability stayed clean.** Tests reference UX-spec strings; ADR-0002's error taxonomy (`key-missing` | `key-invalid` | `quota-exhausted`) appears verbatim in the schema, the dashboard banner, the test assertions, and the security review. This is the payoff of the Sprint 1 ADR-and-design-first approach.
- **Sprint absorbed work without orchestrator churn.** `task-preview-sh` (devops) was absorbed by `task-skeleton-impl` (backend) because the backend agent owns the runtime contract and `preview.sh` is the runtime command surface. Marking the devops task done with `absorbed-by` notation was lighter than re-dispatching.

## What to watch
- **Designer-invented branding ("ArbWatch") propagated without explicit user ratification.** The Sprint 1 designer chose this name; Sprint 2 QA + frontend + backend mirrored it everywhere. Surface to user at the next status checkpoint so they can veto or confirm.
- **Probe-deferred status progression was an in-flight design refinement.** The backend agent (`task-key-backend`) decided not to write `status=ok` on key paste — instead deferring to a Wire probe that hasn't been wired inline yet. This is more correct per ADR-0002 but creates a visible UX issue (dashboard banner persists after paste). Tracked as F4 in the credential security review and as a task in `epic-sprint-2-hardening`. The orchestrator should watch for similar "implementer judgment calls" — they're usually correct but they need to flow back into the design docs and tests, not just the code.
- **Security reviews refused to write their own files.** Both `zeus:security` dispatches returned findings inline citing a conflict between their "write only to docs/security/**" lane discipline and a separate instruction not to write report/summary `.md` files. The orchestrator wrote the files. If this lane-discipline conflict persists, the security agent's prompt should be updated (or the orchestrator should keep writing the review docs itself as a permanent pattern).
- **Test count drift.** QA wrote 17 skeleton tests (5 root + 9 seed + 3 preview); later dispatches reported these as "14 + 3" or "17/17" inconsistently. Tests didn't actually drift, but the counting did. Worth flagging in future task reports: count by test file, not by "all of Sprint 2."

## Lessons for Sprint 3
- **Sprint 3 has the matching + cron heavy lift.** ADR-0002's per-platform field mapping needs verification against real Wire payloads (the architect left TODOs). The Sprint 3 QA dispatch must record fixtures first — that work is already encoded in `task-matching-test`'s DoD.
- **Bundle the security hardening (`epic-sprint-2-hardening`) with Sprint 3.** The four hardening tasks are short and benefit from the same backend agent context as the matching/cron work.
- **Watch context budget.** Sprint 2 consumed substantial agent-token spend (a handful of 30k-200k-token dispatches). Sprint 3 should keep dispatch prompts focused — read-this, do-this, ship-this — and avoid open-ended discovery sub-tasks.
- **Verify the demo before Sprint 3.** Phase 1 success criterion 3 (key-error banner shows when status != ok) is partially tested but not yet end-to-end verified against a real run-through. A 10-minute manual demo path — clone → `./preview.sh` → sign in via the seeded fixture user → paste a key → see the dashboard — would catch any integration gap before Sprint 3 layers on top.
