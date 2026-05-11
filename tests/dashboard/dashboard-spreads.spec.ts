/**
 * tests/dashboard/dashboard-spreads.spec.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-dashboard-spreads implements spread values + freshness + deeplinks +
 *     color treatments + key-error banner on the /dashboard route.
 *
 * Coverage (9 failing tests per DoD):
 *   1. Spread value rendered as "X.Y%" (green / neutral / null states)
 *   2. Color treatment: spread-alert class/attribute for spread > 3%
 *   3. Neutral treatment for 0–3% spread
 *   4. Null spread renders "—" placeholder
 *   5. Last-updated relative timestamp + stale warning treatment
 *   6. Deeplink platform chips (matched vs. no-match, aria-labels)
 *   7. Key-error banners (regression: key-invalid / quota-exhausted / key-missing)
 *   8. Disclaimer string in both sub-header and footer positions
 *   9. Accessibility: spread value aria-label encodes numeric value + "spread" word
 *
 * Design-spec sources (strings locked from these sections):
 *   - docs/design/dashboard.md §5A  — disclaimer string, footer refresh note
 *   - docs/design/dashboard.md §5C  — null-spread placeholder "—"
 *   - docs/design/dashboard.md §5D  — platform chip aria-labels
 *   - docs/design/dashboard.md §5E  — relative timestamp patterns
 *   - docs/design/dashboard.md §5F  — key-error banner copy
 *   - docs/design/dashboard.md §6   — color/treatment rule names
 *   - docs/design/dashboard.md §7D  — spread value aria-label patterns
 *
 * Seed strategy:
 *   Questions A–D are inserted via POST /api/test-seed-spreads (dev-only)
 *   before each describe group, then torn down via POST /api/test-reset after
 *   each test (existing seed-reporter pattern).  The seed endpoint writes
 *   directly to the SQLite DB so the tests do not depend on any matching
 *   engine or cron job.
 *
 *   Seeded states:
 *     Question A  id=30000000-...-0001  spread=0.045  4 platforms  fresh
 *     Question B  id=30000000-...-0002  spread=0.020  2 platforms  fresh
 *     Question C  id=30000000-...-0003  spread=null   1 platform   fresh
 *     Question D  id=30000000-...-0004  spread=0.060  4 platforms  stale (15 min ago)
 *
 * Why these tests will fail against today's dashboard:
 *   WatchedSection.tsx (as of Sprint 3) renders only query_text + Remove button.
 *   It does not render spread values, platform chips, last-updated timestamps,
 *   or any color/treatment attributes.  Every assertion in this file targets
 *   DOM nodes that do not yet exist.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import {
  SESSION_A,
  FIXTURE_USER_A,
} from "../watched/helpers/fixture-watched";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const DASHBOARD_URL = `${BASE_URL}/dashboard`;

const FIXTURE_SESSION_TOKEN =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// Fixture question definitions
// IDs use the 3xxxxxxx range to avoid colliding with seeds in queries.yaml
// (1xxxxxxx) and matching-queries.yaml (2xxxxxxx).
// ---------------------------------------------------------------------------

/**
 * Question A — 4 platforms matched, spread = 0.045.
 * Expected treatment: spread-alert (>3%).
 * Source: docs/design/dashboard.md §6 ("spread > 3% → spread-alert").
 */
const QA = {
  id: "30000000-0000-0000-0000-000000000001",
  query_text: "Will the ECB raise rates before September 2026?",
  spread: 0.045,
  platforms: {
    kalshi:     { matched: true,  market_url: "https://kalshi.com/markets/ecb-rates-sep26",       implied_yes_prob: 0.42 },
    manifold:   { matched: true,  market_url: "https://manifold.markets/ecb-rates-sep26",         implied_yes_prob: 0.465 },
    polymarket: { matched: true,  market_url: "https://polymarket.com/event/ecb-rates-sep26",     implied_yes_prob: 0.43 },
    robinhood:  { matched: true,  market_url: "https://robinhood.com/predictions/ecb-rates-sep26",implied_yes_prob: 0.44 },
  },
  last_updated_offset_minutes: 3, // 3 min ago — fresh
} as const;

/**
 * Question B — 2 platforms matched, spread = 0.020.
 * Expected treatment: spread-neutral (0–3%).
 * Source: docs/design/dashboard.md §6 ("0% < spread ≤ 3% → spread-neutral").
 */
const QB = {
  id: "30000000-0000-0000-0000-000000000002",
  query_text: "Will Germany hold federal elections before August 2026?",
  spread: 0.02,
  platforms: {
    kalshi:     { matched: true,  market_url: "https://kalshi.com/markets/germany-elections-26",  implied_yes_prob: 0.58 },
    manifold:   { matched: false, market_url: null, implied_yes_prob: null },
    polymarket: { matched: true,  market_url: "https://polymarket.com/event/germany-elections-26",implied_yes_prob: 0.60 },
    robinhood:  { matched: false, market_url: null, implied_yes_prob: null },
  },
  last_updated_offset_minutes: 1, // 1 min ago — fresh
} as const;

/**
 * Question C — 1 platform matched, spread = null.
 * Expected treatment: spread-unavailable. Rendered as "—".
 * Source: docs/design/dashboard.md §6 ("spread = null (1 platform match) → spread-unavailable")
 *         and §5C ("Null spread (one platform matched): '—'").
 */
const QC = {
  id: "30000000-0000-0000-0000-000000000003",
  query_text: "Will the UK rejoin the EU single market by 2030?",
  spread: null,
  platforms: {
    kalshi:     { matched: false, market_url: null, implied_yes_prob: null },
    manifold:   { matched: true,  market_url: "https://manifold.markets/uk-eu-single-market-2030",implied_yes_prob: 0.12 },
    polymarket: { matched: false, market_url: null, implied_yes_prob: null },
    robinhood:  { matched: false, market_url: null, implied_yes_prob: null },
  },
  last_updated_offset_minutes: 5, // 5 min ago — fresh
} as const;

/**
 * Question D — 4 platforms matched, spread = 0.060, last_updated 15 min ago.
 * Expected treatment: spread-alert (>3%) AND timestamp-stale.
 * Source: docs/design/dashboard.md §5 State 5 ("last_updated > 10 min → timestamp-stale")
 *         and §6 ("spread > 3% → spread-alert").
 */
const QD = {
  id: "30000000-0000-0000-0000-000000000004",
  query_text: "Will Japan raise interest rates above 1% in 2026?",
  spread: 0.06,
  platforms: {
    kalshi:     { matched: true,  market_url: "https://kalshi.com/markets/japan-rates-2026",      implied_yes_prob: 0.33 },
    manifold:   { matched: true,  market_url: "https://manifold.markets/japan-rates-2026",        implied_yes_prob: 0.39 },
    polymarket: { matched: true,  market_url: "https://polymarket.com/event/japan-rates-2026",    implied_yes_prob: 0.34 },
    robinhood:  { matched: true,  market_url: "https://robinhood.com/predictions/japan-rates-2026",implied_yes_prob: 0.38 },
  },
  last_updated_offset_minutes: 15, // 15 min ago — STALE (> 10 min threshold)
} as const;

// ---------------------------------------------------------------------------
// Locked copy strings
// Source refs are cited per string.
// ---------------------------------------------------------------------------

/**
 * Disclaimer string — appears in both sub-header and footer.
 * Source: docs/design/dashboard.md §5A ("Disclaimer string (used in both sub-header and footer)")
 *   "arb ≠ profit; slippage and fees may eat spread"
 * NOTE: The HTML entity ≠ (≠) is rendered as a Unicode character in the DOM.
 */
const DISCLAIMER_STRING = "arb ≠ profit; slippage and fees may eat spread";

/**
 * Footer refresh note.
 * Source: docs/design/dashboard.md §5A ("Footer refresh note")
 *   "Spread data refreshes every 5 minutes."
 */
const FOOTER_REFRESH_NOTE = "Spread data refreshes every 5 minutes.";

/**
 * Null spread placeholder rendered in the spread cell when spread = null.
 * Source: docs/design/dashboard.md §5C ("Null spread (one platform matched): '—'")
 * and §4 State 3 layout ("Election winner Arizona — —%  5 min ago  (null spread: only 1 platform matched)")
 * The dash character is U+2014 EM DASH as shown in the spec layout ASCII art.
 * The spec uses "—" throughout §5C, §6, and the State 3 diagram.
 */
const NULL_SPREAD_PLACEHOLDER = "—"; // "—"

/**
 * Key-error banner heading (shared by all three error types).
 * Source: docs/design/dashboard.md §5F ("All three banners share the same heading")
 *   "Wire calls paused"
 */
const KEY_ERROR_BANNER_HEADING = "Wire calls paused";

/**
 * key-invalid banner body.
 * Source: docs/design/dashboard.md §5F
 *   "Your Anakin key was rejected — paste a fresh one in Settings."
 */
const KEY_INVALID_BODY =
  "Your Anakin key was rejected — paste a fresh one in Settings.";

/**
 * quota-exhausted banner body (no cooldown timestamp available).
 * Source: docs/design/dashboard.md §5F
 *   "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin
 *    account at anakin.company/wire to resume."
 */
const QUOTA_EXHAUSTED_BODY =
  "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin account at anakin.company/wire to resume.";

/**
 * key-missing banner body.
 * Source: docs/design/dashboard.md §5F
 *   "Add an Anakin key in Settings to start watching markets."
 */
const KEY_MISSING_BODY = "Add an Anakin key in Settings to start watching markets.";

/**
 * Banner CTA link text.
 * Source: docs/design/dashboard.md §5F ("Banner CTA link text: 'Update key'")
 */
const BANNER_CTA_TEXT = "Update key";

/**
 * Banner CTA aria-label.
 * Source: docs/design/dashboard.md §5F ("Banner CTA aria-label: 'Update your Anakin key in Settings'")
 */
const BANNER_CTA_ARIA_LABEL = "Update your Anakin key in Settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject the fixture session cookie for user A.
 * Mirrors the pattern in tests/watched/dashboard-watched.spec.ts.
 */
async function injectFixtureSession(context: BrowserContext): Promise<void> {
  const domain = new URL(BASE_URL).hostname;
  await context.addCookies([
    {
      name: "next-auth.session-token",
      value: FIXTURE_SESSION_TOKEN,
      domain,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Navigate to /dashboard with a valid session.
 * Waits for domcontentloaded and for the <h1> to be present so assertions
 * can begin immediately after.
 */
async function goToDashboard(page: Page, context: BrowserContext): Promise<void> {
  await injectFixtureSession(context);
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
  // Wait for the Watched questions heading to confirm the page rendered
  await page.getByRole("heading", { name: "Watched questions", level: 1 }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

/**
 * Seed spread fixture data via the dev-only seeding endpoint.
 * POST /api/test-seed-spreads writes question_matches + spread_snapshots rows
 * for questions A–D directly into the SQLite DB.
 *
 * This endpoint does not yet exist — the test will fail at this call point
 * when run against today's server, which is correct Mode 1 behaviour.
 * The implementer must create this endpoint alongside the spread UI.
 *
 * The endpoint accepts a JSON body:
 * {
 *   questions: Array<{
 *     id: string,
 *     query_text: string,
 *     user_id: string,
 *     spread: number | null,
 *     last_updated_offset_minutes: number,
 *     platforms: Record<"kalshi"|"manifold"|"polymarket"|"robinhood", {
 *       matched: boolean,
 *       market_url: string | null,
 *       implied_yes_prob: number | null,
 *     }>
 *   }>
 * }
 */
async function seedSpreadFixtures(page: Page): Promise<void> {
  const seedPayload = {
    questions: [QA, QB, QC, QD].map((q) => ({
      id: q.id,
      query_text: q.query_text,
      user_id: FIXTURE_USER_A.id,
      spread: q.spread,
      last_updated_offset_minutes: q.last_updated_offset_minutes,
      platforms: q.platforms,
    })),
  };

  const response = await page.request.post(`${BASE_URL}/api/test-seed-spreads`, {
    data: seedPayload,
    headers: { "Content-Type": "application/json" },
  });

  // If the endpoint is missing (404) or fails, the test fails with a clear message.
  if (!response.ok()) {
    throw new Error(
      `POST /api/test-seed-spreads returned ${response.status()}. ` +
        "The implementer must create this dev-only seeding endpoint alongside " +
        "the spread rendering feature (task-dashboard-spreads)."
    );
  }
}

/**
 * Tear down spread fixture data via the existing test-reset endpoint.
 * The test-reset route removes all non-seed questions; question_matches and
 * spread_snapshots are deleted via CASCADE from watched_questions.
 */
async function tearDownSpreadFixtures(page: Page): Promise<void> {
  await page.request.post(`${BASE_URL}/api/test-reset`);
}

// ---------------------------------------------------------------------------
// Test 1 — Spread values rendered as "X.Y%"
// Source: docs/design/dashboard.md §4 State 3 layout diagram
//   "4.2%", "1.1%" — format is one decimal place followed by "%"
//   Edge case §E4: "0%" renders as "0.0%" per spec.
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — spread values rendered (DoD item 1)", () => {
  test.beforeEach(async ({ page }) => {
    // Seed data is inserted via the fixture helper before each test.
    // The helper posts to /api/test-seed-spreads which does not yet exist.
    // Failure here is correct Mode 1 behaviour.
  });

  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question A (spread 0.045) renders as '4.5%' in the spread cell",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        // Wait for Question A's query text to be visible so the list has loaded
        await page.getByText(QA.query_text).waitFor({ state: "visible", timeout: 10_000 });

        // The spread cell for Question A must contain "4.5%"
        // Format rule: X.Y% (one decimal place).
        // Source: docs/design/dashboard.md §4 State 3 layout ("4.2%", "1.1%")
        const rowA = page.locator("li, tr").filter({ hasText: QA.query_text });
        await expect(
          rowA.getByText("4.5%"),
          `Question A (spread=0.045) must render as "4.5%" in the spread cell. ` +
            `Format rule: X.Y% (one decimal place). ` +
            `Source: docs/design/dashboard.md §4 State 3 layout. ` +
            `WatchedSection.tsx does not currently render any spread value — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question B (spread 0.020) renders as '2.0%' in the spread cell",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QB.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowB = page.locator("li, tr").filter({ hasText: QB.query_text });
        await expect(
          rowB.getByText("2.0%"),
          `Question B (spread=0.020) must render as "2.0%" in the spread cell. ` +
            `Format rule: X.Y% (one decimal place). ` +
            `Source: docs/design/dashboard.md §4 State 3 layout. ` +
            `WatchedSection.tsx does not currently render any spread value — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 2 — Color treatment: spread-alert for spread > 3%
// Source: docs/design/dashboard.md §6
//   "spread > 3% (alert threshold) | spread-alert | Success-positive / green family"
// Implementation note: The spec uses the treatment name "spread-alert".
// The test checks for a CSS class "spread--alert" OR a data attribute
// data-treatment="spread-alert" on the spread cell element, mirroring the
// spec's semantic naming convention (§6 "These rules use semantic treatment names").
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — spread-alert color treatment (DoD item 2)", () => {
  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question A (spread 4.5%) has spread-alert treatment (CSS class or data-treatment attribute)",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QA.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowA = page.locator("li, tr").filter({ hasText: QA.query_text });

        // The spread cell must have a visual indicator for the alert state.
        // Check for either the CSS class "spread--alert" or the data-attribute
        // data-treatment="spread-alert". The implementer chooses the exact attribute;
        // the spec mandates the treatment name "spread-alert" (docs/design/dashboard.md §6).
        const spreadCellAlert = rowA.locator(
          "[class*='spread--alert'], [data-treatment='spread-alert']"
        );
        await expect(
          spreadCellAlert,
          `Question A (spread=4.5%) must have the "spread-alert" treatment. ` +
            `Expected a DOM node with class "spread--alert" or data-treatment="spread-alert". ` +
            `Source: docs/design/dashboard.md §6 ` +
            `("spread > 3% → spread-alert / Success-positive / green family"). ` +
            `WatchedSection.tsx renders no spread cell at all — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question D (spread 6.0%, stale) also has spread-alert treatment on the spread value",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QD.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowD = page.locator("li, tr").filter({ hasText: QD.query_text });

        // Even for stale rows, the spread value retains its color treatment.
        // Source: docs/design/dashboard.md §4 State 5
        //   "The spread value itself is not greyed out — it retains its normal color
        //    treatment because the value is still valid; only its freshness is uncertain."
        const spreadCellAlert = rowD.locator(
          "[class*='spread--alert'], [data-treatment='spread-alert']"
        );
        await expect(
          spreadCellAlert,
          `Question D (spread=6.0%, stale) must have the "spread-alert" treatment on the spread cell. ` +
            `The stale state must NOT grey out the spread value. ` +
            `Source: docs/design/dashboard.md §4 State 5. ` +
            `WatchedSection.tsx renders no spread cell at all — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 3 — Neutral treatment for 0–3% spread
// Source: docs/design/dashboard.md §6
//   "0% < spread ≤ 3% | spread-neutral | Normal body text color. No special emphasis."
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — spread-neutral treatment (DoD item 3)", () => {
  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question B (spread 2.0%) has spread-neutral treatment, NOT spread-alert",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QB.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowB = page.locator("li, tr").filter({ hasText: QB.query_text });

        // Check the spread cell has the neutral treatment
        const spreadCellNeutral = rowB.locator(
          "[class*='spread--neutral'], [data-treatment='spread-neutral']"
        );
        await expect(
          spreadCellNeutral,
          `Question B (spread=2.0%) must have the "spread-neutral" treatment. ` +
            `Expected a DOM node with class "spread--neutral" or data-treatment="spread-neutral". ` +
            `Source: docs/design/dashboard.md §6 ` +
            `("0% < spread ≤ 3% → spread-neutral / Normal body text color"). ` +
            `WatchedSection.tsx renders no spread cell at all — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });

        // Verify it does NOT have the alert treatment
        const spreadCellAlert = rowB.locator(
          "[class*='spread--alert'], [data-treatment='spread-alert']"
        );
        await expect(
          spreadCellAlert,
          `Question B (spread=2.0%) must NOT have the "spread-alert" treatment. ` +
            `The alert treatment is only for spread > 3%. ` +
            `Source: docs/design/dashboard.md §6.`
        ).not.toBeVisible({ timeout: 3_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 4 — Null spread renders "—" placeholder
// Source: docs/design/dashboard.md §5C
//   "Null spread (one platform matched): '—'"
//   (the em dash U+2014, also shown in the State 3 layout diagram)
// and §6 ("spread = null (1 platform match) → spread-unavailable, rendered as '—'")
// and §7D aria-label: "Spread unavailable — only one platform matched this question"
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — null spread placeholder (DoD item 4)", () => {
  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question C (1 platform, null spread) renders '—' in the spread cell",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QC.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowC = page.locator("li, tr").filter({ hasText: QC.query_text });

        // The spread cell must contain the em dash character
        await expect(
          rowC.getByText(NULL_SPREAD_PLACEHOLDER),
          `Question C (spread=null, 1 platform) must render "${NULL_SPREAD_PLACEHOLDER}" (U+2014 em dash) ` +
            `in the spread cell. ` +
            `Source: docs/design/dashboard.md §5C ("Null spread (one platform matched): '—'") ` +
            `and §4 State 3 layout diagram. ` +
            `WatchedSection.tsx renders no spread cell at all — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question C null spread cell has spread-unavailable treatment and correct aria-label",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QC.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowC = page.locator("li, tr").filter({ hasText: QC.query_text });

        // Check for spread-unavailable treatment
        const spreadCellUnavailable = rowC.locator(
          "[class*='spread--unavailable'], [data-treatment='spread-unavailable']"
        );
        await expect(
          spreadCellUnavailable,
          `Question C null spread must have the "spread-unavailable" treatment. ` +
            `Source: docs/design/dashboard.md §6 ` +
            `("spread = null (1 platform match) → spread-unavailable / Disabled-text / muted"). ` +
            `WatchedSection.tsx renders no spread cell — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });

        // Check aria-label per docs/design/dashboard.md §7D
        // "null spread (1 platform match): aria-label='Spread unavailable — only one platform matched this question'"
        const expectedAriaLabel =
          "Spread unavailable — only one platform matched this question";
        const spreadCellWithAriaLabel = rowC.locator(
          `[aria-label="${expectedAriaLabel}"]`
        );
        await expect(
          spreadCellWithAriaLabel,
          `Question C spread cell must have ` +
            `aria-label="${expectedAriaLabel}". ` +
            `Source: docs/design/dashboard.md §7D. ` +
            `WatchedSection.tsx renders no spread cell — this test MUST FAIL.`
        ).toBeAttached({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 5 — Last-updated relative timestamp + stale warning
// Source: docs/design/dashboard.md §5E (timestamp patterns)
//   "Relative timestamp pattern (1–59 min): 'N min ago'"
// and §4 State 5 (stale > 10 min):
//   "Rows with last_updated > 10 min render the timestamp in the
//    warning/attention treatment (timestamp-stale) with a warning glyph."
// and aria-label for stale rows (§5E):
//   "Last updated {relative time} — data may be stale"
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — last-updated timestamp (DoD item 5)", () => {
  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question A (3 min ago) shows '3 min ago' in the timestamp region",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QA.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowA = page.locator("li, tr").filter({ hasText: QA.query_text });

        // Timestamp format: "N min ago" per docs/design/dashboard.md §5E
        // The seed sets last_updated to 3 minutes before test execution time.
        await expect(
          rowA.getByText("3 min ago"),
          `Question A (last_updated 3 min ago) must render "3 min ago" in the timestamp region. ` +
            `Format: "N min ago" per docs/design/dashboard.md §5E. ` +
            `WatchedSection.tsx renders no timestamp — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question D (15 min ago, stale) shows timestamp-stale treatment",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QD.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowD = page.locator("li, tr").filter({ hasText: QD.query_text });

        // The timestamp cell must have the timestamp-stale treatment
        // Source: docs/design/dashboard.md §6
        //   "last_updated > 10 min → timestamp-stale / Warning / attention color. A warning icon is added."
        const staleTimestamp = rowD.locator(
          "[class*='timestamp--stale'], [data-treatment='timestamp-stale']"
        );
        await expect(
          staleTimestamp,
          `Question D (last_updated 15 min ago) must have the "timestamp-stale" treatment. ` +
            `Source: docs/design/dashboard.md §6 ` +
            `("last_updated > 10 min → timestamp-stale, Warning/attention color"). ` +
            `WatchedSection.tsx renders no timestamp — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question D stale timestamp aria-label includes 'data may be stale' suffix",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QD.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowD = page.locator("li, tr").filter({ hasText: QD.query_text });

        // aria-label for stale timestamp must include the "data may be stale" suffix.
        // Source: docs/design/dashboard.md §5E
        //   "Stale suffix (> 10 min, added to the aria-label only):
        //    'Last updated {relative time} — data may be stale'"
        // The timestamp is 15 min ago so the aria-label reads:
        // "Last updated 15 min ago — data may be stale"
        const staleAriaLabel = "Last updated 15 min ago — data may be stale";
        const staleTimestampEl = rowD.locator(`[aria-label="${staleAriaLabel}"]`);
        await expect(
          staleTimestampEl,
          `Question D stale timestamp must have ` +
            `aria-label="${staleAriaLabel}". ` +
            `Source: docs/design/dashboard.md §5E ` +
            `("Stale suffix: 'Last updated {relative time} — data may be stale'"). ` +
            `WatchedSection.tsx renders no timestamp — this test MUST FAIL.`
        ).toBeAttached({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 6 — Platform deeplink chips
// Source: docs/design/dashboard.md §3 (row anatomy) and §5D (chip copy)
//
// Matched chip:
//   - Rendered as <a href="<market_url>" target="_blank" rel="noopener noreferrer">
//   - aria-label: "View on {Platform} (opens in new tab)"
//   - Visible text: platform name only
//
// No-match chip:
//   - No <a> element; greyed out
//   - aria-disabled="true"
//   - aria-label: "Not matched on {Platform}"
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — platform deeplink chips (DoD item 6)", () => {
  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question A row shows 4 platform chips: all matched with external links",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QA.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowA = page.locator("li, tr").filter({ hasText: QA.query_text });
        const platforms = ["Kalshi", "Manifold", "Polymarket", "Robinhood"] as const;

        for (const platform of platforms) {
          // Each matched chip is an <a> with correct aria-label
          // Source: docs/design/dashboard.md §5D
          //   "Chip with match (accessible label): 'View on {Platform} (opens in new tab)'"
          const chipLink = rowA.getByRole("link", {
            name: `View on ${platform} (opens in new tab)`,
          });
          await expect(
            chipLink,
            `Question A row must have a matched chip link for ${platform} ` +
              `with aria-label "View on ${platform} (opens in new tab)". ` +
              `Source: docs/design/dashboard.md §5D. ` +
              `WatchedSection.tsx renders no platform chips — this test MUST FAIL.`
          ).toBeVisible({ timeout: 5_000 });

          // The link must open in a new tab
          await expect(
            chipLink,
            `The ${platform} chip link must have target="_blank". ` +
              `Source: docs/design/dashboard.md §3 row anatomy ` +
              `("rendered as an <a> to the platform market page").`
          ).toHaveAttribute("target", "_blank");

          await expect(
            chipLink,
            `The ${platform} chip link must have rel="noopener noreferrer". ` +
              `Source: docs/design/dashboard.md §3 row anatomy.`
          ).toHaveAttribute("rel", "noopener noreferrer");
        }
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question B row shows 2 matched chips and 2 no-match chips with correct aria-labels",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QB.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowB = page.locator("li, tr").filter({ hasText: QB.query_text });

        // Kalshi — matched
        await expect(
          rowB.getByRole("link", { name: "View on Kalshi (opens in new tab)" }),
          `Question B must have a matched Kalshi chip with aria-label "View on Kalshi (opens in new tab)". ` +
            `Source: docs/design/dashboard.md §5D. ` +
            `WatchedSection.tsx renders no platform chips — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });

        // Polymarket — matched
        await expect(
          rowB.getByRole("link", { name: "View on Polymarket (opens in new tab)" }),
          `Question B must have a matched Polymarket chip with correct aria-label. ` +
            `Source: docs/design/dashboard.md §5D.`
        ).toBeVisible({ timeout: 5_000 });

        // Manifold — no match: aria-disabled="true", no link
        // Source: docs/design/dashboard.md §5D
        //   "No-match chip: name only, greyed out, aria-disabled='true', no link,
        //    aria-label='Not matched on {Platform}'"
        const manifoldNoMatch = rowB.locator(
          `[aria-label="Not matched on Manifold"][aria-disabled="true"]`
        );
        await expect(
          manifoldNoMatch,
          `Question B must have a no-match Manifold chip with ` +
            `aria-label="Not matched on Manifold" and aria-disabled="true". ` +
            `Source: docs/design/dashboard.md §5D. ` +
            `WatchedSection.tsx renders no platform chips — this test MUST FAIL.`
        ).toBeVisible({ timeout: 5_000 });

        // Robinhood — no match
        const robinhoodNoMatch = rowB.locator(
          `[aria-label="Not matched on Robinhood"][aria-disabled="true"]`
        );
        await expect(
          robinhoodNoMatch,
          `Question B must have a no-match Robinhood chip with ` +
            `aria-label="Not matched on Robinhood" and aria-disabled="true". ` +
            `Source: docs/design/dashboard.md §5D.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "no-match chips are not <a> links (they must not be focusable interactive links)",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QB.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowB = page.locator("li, tr").filter({ hasText: QB.query_text });

        // No-match chips must not be <a> elements — no link href
        // Source: docs/design/dashboard.md §3 row anatomy
        //   "No-match chip: name only, greyed out, aria-disabled='true', no link"
        // and §7A: "no-match chips are not focusable because they are not interactive"
        const manifoldNoMatchLink = rowB.locator(
          `a[aria-label="Not matched on Manifold"]`
        );
        await expect(
          manifoldNoMatchLink,
          `No-match chips must not be <a> elements. ` +
            `Source: docs/design/dashboard.md §3 ` +
            `("No-match chip: name only, greyed out, aria-disabled='true', no link") ` +
            `and §7A ("no-match chips are not focusable because they are not interactive"). ` +
            `WatchedSection.tsx renders no platform chips — this test MUST FAIL at the prior assertions.`
        ).not.toBeAttached({ timeout: 3_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 7 — Key-error banner regression coverage
// Source: docs/design/dashboard.md §5F, §6 (banner treatment), §7E (banner ARIA)
//
// DashboardClient.tsx already renders the banner for key-invalid / quota-exhausted
// / key-missing. These tests are regression coverage to confirm the Sprint 2/3
// implementation still holds after the spread overlay is added.
//
// Authentication: use the secondary fixture user (FIXTURE_USER_B, status=key-missing)
// for the key-missing test; toggle key status via /api/test-set-key-status (dev-only)
// for the other two.
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — key-error banner regression (DoD item 7)", () => {
  /**
   * Set the fixture user's anakin_key_status via the dev-only endpoint.
   * POST /api/test-set-key-status { user_id, status }
   * This endpoint does not yet exist — failure here is correct Mode 1 behaviour.
   */
  async function setKeyStatus(
    page: Page,
    status: "ok" | "key-invalid" | "quota-exhausted" | "key-missing"
  ): Promise<void> {
    const response = await page.request.post(`${BASE_URL}/api/test-set-key-status`, {
      data: { user_id: FIXTURE_USER_A.id, status },
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok()) {
      throw new Error(
        `POST /api/test-set-key-status returned ${response.status()}. ` +
          "The implementer must provide this dev-only endpoint for key-error tests."
      );
    }
  }

  test.afterEach(async ({ page }) => {
    // Restore key status to "ok" after each test
    await page.request.post(`${BASE_URL}/api/test-set-key-status`, {
      data: { user_id: FIXTURE_USER_A.id, status: "ok" },
      headers: { "Content-Type": "application/json" },
    }).catch(() => { /* ignore cleanup failure */ });
  });

  test(
    "key-invalid: banner shows 'Wire calls paused' and key-invalid body copy",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await injectFixtureSession(context);
        await setKeyStatus(page, "key-invalid");
        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });

        // Banner heading
        await expect(
          page.getByText(KEY_ERROR_BANNER_HEADING),
          `The key-invalid banner must show heading "${KEY_ERROR_BANNER_HEADING}". ` +
            `Source: docs/design/dashboard.md §5F. ` +
            `DashboardClient.tsx already renders this — regression test.`
        ).toBeVisible({ timeout: 5_000 });

        // key-invalid body copy
        // Source: docs/design/dashboard.md §5F
        //   "Your Anakin key was rejected — paste a fresh one in Settings."
        // NOTE: The em dash in the copy is U+2014.
        const keyInvalidBody =
          "Your Anakin key was rejected — paste a fresh one in Settings.";
        await expect(
          page.getByText(keyInvalidBody),
          `The key-invalid banner must show body: "${keyInvalidBody}". ` +
            `Source: docs/design/dashboard.md §5F. ` +
            `DashboardClient.tsx BANNER_COPY["key-invalid"].body is already set — regression test.`
        ).toBeVisible({ timeout: 5_000 });

        // Banner CTA
        await expect(
          page.getByRole("link", { name: BANNER_CTA_ARIA_LABEL }),
          `The key-error banner must include a CTA link with aria-label "${BANNER_CTA_ARIA_LABEL}". ` +
            `Source: docs/design/dashboard.md §5F.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "quota-exhausted: banner shows 'Wire calls paused' and quota-exhausted body copy",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await injectFixtureSession(context);
        await setKeyStatus(page, "quota-exhausted");
        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });

        await expect(
          page.getByText(KEY_ERROR_BANNER_HEADING),
          `The quota-exhausted banner must show heading "${KEY_ERROR_BANNER_HEADING}". ` +
            `Source: docs/design/dashboard.md §5F.`
        ).toBeVisible({ timeout: 5_000 });

        // quota-exhausted fallback body (no cooldown timestamp)
        // Source: docs/design/dashboard.md §5F
        //   "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin
        //    account at anakin.company/wire to resume."
        const quotaBody =
          "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin account at anakin.company/wire to resume.";
        await expect(
          page.getByText(quotaBody),
          `The quota-exhausted banner body must read: "${quotaBody}". ` +
            `Source: docs/design/dashboard.md §5F (fallback copy, no cooldown timestamp). ` +
            `DashboardClient.tsx BANNER_COPY["quota-exhausted"].body is already set — regression test.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "key-missing: banner shows 'Wire calls paused' and key-missing body copy",
    async ({ browser }) => {
      // Use fixture user B (status=key-missing) for this test.
      // User B is seeded with key-missing status in queries.yaml.
      // This test does not require the set-key-status endpoint.
      const FIXTURE_SESSION_TOKEN_B =
        process.env.FIXTURE_SESSION_TOKEN_B ??
        "fixture-session-token-b-do-not-use-in-prod";

      const context = await browser.newContext();
      try {
        const domain = new URL(BASE_URL).hostname;
        await context.addCookies([
          {
            name: "next-auth.session-token",
            value: FIXTURE_SESSION_TOKEN_B,
            domain,
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ]);

        const page = await context.newPage();
        // User B has key-missing status; the page would redirect to /onboarding/key
        // unless ?welcome=1 is appended (see page.tsx:84 redirect logic).
        await page.goto(`${DASHBOARD_URL}?welcome=1`, { waitUntil: "domcontentloaded" });

        await expect(
          page.getByText(KEY_ERROR_BANNER_HEADING),
          `The key-missing banner must show heading "${KEY_ERROR_BANNER_HEADING}". ` +
            `Source: docs/design/dashboard.md §5F.`
        ).toBeVisible({ timeout: 5_000 });

        // key-missing body
        // Source: docs/design/dashboard.md §5F
        //   "Add an Anakin key in Settings to start watching markets."
        await expect(
          page.getByText(KEY_MISSING_BODY),
          `The key-missing banner body must read: "${KEY_MISSING_BODY}". ` +
            `Source: docs/design/dashboard.md §5F. ` +
            `DashboardClient.tsx BANNER_COPY["key-missing"].body is already set — regression test.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 8 — Disclaimer string present in both sub-header and footer
// Source: docs/design/dashboard.md §3 (Layout, "Disclaimer placement rule")
//   "The disclaimer string 'arb ≠ profit; slippage and fees may eat spread' appears
//    in two fixed locations on every view that renders spread values"
//   1. Immediately below the page <h1>, above the add-question row — <p id="spread-disclaimer">
//   2. Footer — last line of the page footer
//
// DashboardClient.tsx already renders both. This is regression + spec-string lock.
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — disclaimer placement (DoD item 8)", () => {
  test(
    "disclaimer appears in the sub-header position (p#spread-disclaimer)",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Source: docs/design/dashboard.md §3 component hierarchy
        //   "<p id='spread-disclaimer' class='disclaimer'>
        //    arb ≠ profit; slippage and fees may eat spread
        //   </p>"
        const disclaimerEl = page.locator("#spread-disclaimer");
        await expect(
          disclaimerEl,
          `The disclaimer element #spread-disclaimer must be present in the DOM. ` +
            `Source: docs/design/dashboard.md §3 component hierarchy. ` +
            `DashboardClient.tsx already renders this — regression test.`
        ).toBeAttached({ timeout: 5_000 });

        await expect(
          disclaimerEl,
          `The #spread-disclaimer element must contain the exact disclaimer string. ` +
            `Source: docs/design/dashboard.md §5A ` +
            `("Disclaimer string: 'arb ≠ profit; slippage and fees may eat spread'"). ` +
            `Note: ≠ is Unicode U+2260.`
        ).toContainText(DISCLAIMER_STRING, { timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "disclaimer appears in the footer",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Source: docs/design/dashboard.md §3 component hierarchy
        //   "<footer>
        //    <p>arb ≠ profit; slippage and fees may eat spread</p>
        //    <p>Spread data refreshes every 5 minutes.</p>
        //   </footer>"
        const footer = page.locator("footer");
        await expect(
          footer,
          `The page must have a <footer> element. ` +
            `Source: docs/design/dashboard.md §3 component hierarchy. ` +
            `DashboardClient.tsx already renders this — regression test.`
        ).toBeAttached({ timeout: 5_000 });

        await expect(
          footer,
          `The footer must contain the disclaimer string "${DISCLAIMER_STRING}". ` +
            `Source: docs/design/dashboard.md §5A.`
        ).toContainText(DISCLAIMER_STRING, { timeout: 5_000 });

        // Footer refresh note
        // Source: docs/design/dashboard.md §5A ("Footer refresh note: 'Spread data refreshes every 5 minutes.'")
        await expect(
          footer,
          `The footer must contain "${FOOTER_REFRESH_NOTE}". ` +
            `Source: docs/design/dashboard.md §5A.`
        ).toContainText(FOOTER_REFRESH_NOTE, { timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 9 — Accessibility: spread aria-label encodes numeric value + "spread" word
// Source: docs/design/dashboard.md §7D
//   "Every spread value cell must have an aria-label that encodes the semantic
//    meaning, not just the raw number"
//   - spread > 3%: aria-label="Spread: 4.2% — above alert threshold"
//   - 0% < spread ≤ 3%: aria-label="Spread: 1.1%"
// ---------------------------------------------------------------------------

test.describe("Dashboard spreads — spread cell accessibility (DoD item 9)", () => {
  test.afterEach(async ({ page }) => {
    await tearDownSpreadFixtures(page);
  });

  test(
    "Question A spread cell has aria-label 'Spread: 4.5% — above alert threshold'",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QA.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowA = page.locator("li, tr").filter({ hasText: QA.query_text });

        // Source: docs/design/dashboard.md §7D
        //   "spread > 3%: aria-label='Spread: 4.2% — above alert threshold'"
        // For Question A (spread=0.045 → "4.5%"):
        //   aria-label="Spread: 4.5% — above alert threshold"
        const expectedAriaLabel =
          "Spread: 4.5% — above alert threshold";
        const spreadCellEl = rowA.locator(`[aria-label="${expectedAriaLabel}"]`);
        await expect(
          spreadCellEl,
          `Question A spread cell must have ` +
            `aria-label="${expectedAriaLabel}". ` +
            `Source: docs/design/dashboard.md §7D. ` +
            `WatchedSection.tsx renders no spread cell — this test MUST FAIL.`
        ).toBeAttached({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Question B spread cell has aria-label 'Spread: 2.0%' (neutral, no threshold suffix)",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);
        await seedSpreadFixtures(page);
        await page.reload({ waitUntil: "domcontentloaded" });

        await page.getByText(QB.query_text).waitFor({ state: "visible", timeout: 10_000 });

        const rowB = page.locator("li, tr").filter({ hasText: QB.query_text });

        // Source: docs/design/dashboard.md §7D
        //   "0% < spread ≤ 3%: aria-label='Spread: 1.1%'"
        // For Question B (spread=0.020 → "2.0%"):
        //   aria-label="Spread: 2.0%"
        const expectedAriaLabel = "Spread: 2.0%";
        const spreadCellEl = rowB.locator(`[aria-label="${expectedAriaLabel}"]`);
        await expect(
          spreadCellEl,
          `Question B spread cell must have aria-label="${expectedAriaLabel}". ` +
            `Source: docs/design/dashboard.md §7D ` +
            `("0% < spread ≤ 3%: aria-label='Spread: 1.1%'" — pattern applied to 2.0%). ` +
            `WatchedSection.tsx renders no spread cell — this test MUST FAIL.`
        ).toBeAttached({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});
