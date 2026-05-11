# Phase 1 — Human verification checklist

**Phase:** phase-1-mvp
**Status:** All 10 success criteria implementation-complete. Two verification items below remain before formal Phase 1 close.

The orchestrator has paused Phase 1 close pending these. Run through them, mark each `[x]`, and `/zeus:run` again to advance.

---

## 1. Live-server Playwright run-through

~33 Playwright tests across Sprints 3-4 were validated against the implementation by contract-matching (test assertions vs the code), but were NOT executed against a live preview.sh server.

**Procedure:**

```bash
./preview.sh   # in one terminal
```

Then in another terminal:

```bash
npm run test:e2e
```

The Playwright suites that should run:
- `tests/auth/redirect-when-authenticated.spec.ts` (7)
- `tests/auth/session-persistence.spec.ts` (3)
- `tests/key/onboarding-flow.spec.ts` (19, 1 skipped)
- `tests/watched/dashboard-watched.spec.ts` (13)
- `tests/dashboard/dashboard-spreads.spec.ts` (20)
- `tests/disclaimer/disclaimer.spec.ts` (3 of the 7 are Playwright; the other 4 are Vitest)

Expected: ≥61 Playwright tests, ~60 passing + 1 explicit skip.

**Pass/fail criteria for Phase 1 close:**
- All Sprint 2 Playwright tests (auth + key) still pass (these passed live at end of Sprint 2).
- New Sprint 3-4 Playwright tests pass against the live server. If any fail, file an issue and decide whether it's:
  - (a) a real bug in the implementation that should be fixed before Phase 1 close, or
  - (b) a test infrastructure / fixture issue that can be deferred to Phase 2.

**Check when done:**

- [ ] Playwright suite runs to completion against live `./preview.sh`.
- [ ] ≥60 tests pass; failures (if any) are categorized as bug vs infra and tracked.

---

## 2. Real-Wire field-mapping spot-check

ADR-0002 commits to the midpoint-of-YES-bid/ask convention with last-trade fallback across all 4 platforms. The Sprint-3 matching engine reads `implied_yes_prob` via `lib/wire/mapping.ts:extractImpliedYesProb` using per-platform JSON paths.

These paths were verified against synthetically-recorded fixtures in `tests/fixtures/wire/**`. The fixtures themselves were authored by the QA agent to match the ADR's documented convention — meaning the test passes are meta-circular (test the agent's fixtures against the ADR the agent read).

**Procedure:**

Pick one query that has real market activity on all 4 platforms (e.g. "Fed cuts rates June 2026"). With a valid Anakin Wire key in env (`ANAKIN_API_KEY=...`):

```bash
WIRE_MODE=live npx tsx scripts/record-wire-fixture.ts kl_events fed-cuts-rates-real
WIRE_MODE=live npx tsx scripts/record-wire-fixture.ts mm_search_markets fed-cuts-rates-real
WIRE_MODE=live npx tsx scripts/record-wire-fixture.ts pm_get_events fed-cuts-rates-real
WIRE_MODE=live npx tsx scripts/record-wire-fixture.ts rh_get_events fed-cuts-rates-real
```

For each recorded fixture, manually inspect the JSON. Confirm:
- The path documented in ADR-0002 §"Field mapping per platform" (`yes_bid`, `yes_ask`, `last_yes_price` per platform — see exact paths in the ADR) resolves to a numeric value in the recorded payload.
- If any path is wrong, patch `lib/wire/mapping.ts` and update ADR-0002.

**Check when done:**

- [ ] At least 1 real Wire payload recorded per platform.
- [ ] ADR-0002's JSON paths resolve to numbers on real payloads.
- [ ] If a path was wrong, `lib/wire/mapping.ts` patched and ADR updated; matching tests still pass with the updated paths (re-record fixtures + re-run matching tests).

---

## After completing both

When both items above are checked, run `/zeus:run` again. The orchestrator will detect both Phase 1 verification items resolved, mark Phase 1 done, update CHANGELOG, and open Phase 2 (multi-user + smarter matching).

If something failed and needs orchestrator work to fix, just tell me what needs to happen and I'll dispatch the relevant role.
