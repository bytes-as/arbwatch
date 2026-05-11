# Sprint 1 — Retro

## Stats
- Stories shipped: 4 / 4 (100%)
- Tasks dispatched: 4
- Avg attempts per task: 1.0 (no retries)
- Blockers escalated: 0
- Roles exercised: architect (×2), designer (×2)

## What went well
- Clean parallelization: 2× (architect + designer) dispatch batches kept all 4 specialists busy without blocking on each other.
- The architect's two ADRs cross-reference cleanly — `0002-wire-integration.md` correctly grounds its decisions in `0001-stack.md`.
- Designer specs reference the ADR error taxonomy verbatim, which removes ambiguity for the frontend agent in Sprint 2+.

## What to watch
- Both architect dispatches surfaced "forward-phase gates" that are real but not actionable until later phases. The orchestrator captured them in DECISIONS.log rather than letting them bloat Phase 1. Confirm this pattern keeps working as later phases open.
- The Wire field-mapping convention (midpoint of YES bid/ask, fallback to last trade) is a confident default but unverified against live payloads. Sprint 3 QA work (recording Wire fixtures) must verify and patch `lib/wire/mapping.ts` if any per-platform path is wrong. The backlog amendment to `task-matching-test` already encodes this.

## Lessons for Sprint 2
- Sprint 2 will be the first sprint with multi-task stories (skeleton, auth, key-storage each have QA + impl + frontend/security tasks). Watch maxParallel=2 and keep dispatches independent across stories (one story's QA can run with a different story's impl-after-QA).
- The stack ADR commits to Next.js App Router + NextAuth v5 + Drizzle; the Sprint 2 backend agent must work within those choices and read `0001-stack.md` for the runtime conventions before writing any code.
