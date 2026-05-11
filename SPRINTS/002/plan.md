# Sprint 2 — Skeleton + Auth + Key Storage

**Phase:** phase-1-mvp — MVP: Watched questions + email alerts
**Opened:** 2026-05-10

## Goal
Get the app booting via `./preview.sh` and let a fresh visitor complete the entire onboarding flow: request magic link → click email → land authenticated → paste Anakin Wire key → reach the (empty) dashboard.

End-of-sprint demo path: clone the repo, run `./preview.sh`, open `http://localhost:3000`, sign in as a seeded fixture user, paste the fixture Anakin key, see the dashboard's empty state.

## Phase context
Phase 1 has 10 success criteria; this sprint targets 4 of them (sign-up + session persistence; BYO-key paste + encryption; preview.sh + seed; README quickstart). The remaining 6 (watched questions, matching, cron, dashboard, alerts, disclaimer) come in Sprints 3-5.

## Committed stories
1. **story-skeleton** (P1, foundation) — App boots locally via `./preview.sh` against seeded SQLite, README quickstart copy-pastes to a running app in <60s. 4 tasks: qa-test → backend-impl → devops-preview → tech_writer-readme.
2. **story-magic-link-auth** (P0, auth) — Email magic-link signup + persistent session per the onboarding UX spec and NextAuth v5 from ADR-0001. 4 tasks: qa-test → backend → frontend → security-review.
3. **story-anakin-key-storage** (P0, credentials) — Paste / rotate / remove Anakin key, AES-256-GCM at rest, scoped per user, with the `anakin_key_status` enum column from ADR-0002. 4 tasks: qa-test → backend → frontend → security-review.

## Dispatch plan (maxParallel=2)
QA-first for each story (Mode 1: write failing tests) before any implementer touches it.

- Wave 1: qa(task-skeleton-test) ‖ qa(task-auth-test)
- Wave 2: qa(task-key-test) ‖ backend(task-skeleton-impl)
- Wave 3: devops(task-preview-sh) ‖ backend(task-auth-backend)
- Wave 4: frontend(task-auth-frontend) ‖ backend(task-key-backend)
- Wave 5: security(task-auth-security-review) ‖ frontend(task-key-frontend)
- Wave 6: security(task-key-security-review) ‖ tech_writer(task-readme-quickstart)

(Waves are guidance; the orchestrator may resequence based on actual blockers.)

## Out of scope for Sprint 2
- Watched-question CRUD, cross-platform matching, spread cron — Sprint 3.
- Dashboard implementation (the design spec exists; build comes after key storage works) — Sprint 4 or 5.
- Email alerts and disclaimer enforcement — Sprint 5.
