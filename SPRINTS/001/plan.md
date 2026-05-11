# Sprint 1 — Foundations

**Phase:** phase-1-mvp — MVP: Watched questions + email alerts
**Opened:** 2026-05-10

## Goal
Lay the architectural and UX foundations so subsequent sprints can build to spec without ambiguity. No product code yet — just decisions and design specs that downstream stories will reference.

## Phase context
Phase 1 ships an email-magic-link, BYO-Anakin-key web app where a single user watches up to 5 questions and gets emailed when cross-platform spreads exceed 3%. Free-tier hosting is a hard constraint.

## Committed stories
1. **story-stack-decision** (architect) — Choose runtime, framework, DB, scheduler, email transport, secrets/encryption, deploy target. Free-tier required.
2. **story-wire-integration-adr** (architect) — Document how Wire actions are invoked per-user using each user's Anakin key, fixture mode for local dev, error taxonomy.
3. **story-onboarding-design** (designer) — UX spec for magic-link signup + BYO-key onboarding + key-error states.
4. **story-dashboard-design** (designer) — UX spec for the watched-questions dashboard: spread display, freshness, deeplinks, key-error banner, disclaimer placement.

## Dispatch order
- Batch 1 (parallel, maxParallel=2): task-stack-adr (architect) + task-onboarding-design (designer) — different roles, independent artifacts.
- Batch 2: task-wire-adr (architect) + task-dashboard-design (designer) — kicked off once Batch 1 returns.

## Out of scope for Sprint 1
- Skeleton + preview.sh (waits on stack ADR)
- Auth + key implementation (waits on stack ADR + onboarding UX)
- Watched questions, matching, cron, dashboard impl, alerts (waits on everything above)
