/**
 * tests/history/dashboard-sparkline.spec.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - The spread_history table exists and is populated by the cron
 *   - The dashboard GET /dashboard fetches spread_history per question
 *   - WatchedSection.tsx (or a child) renders an <svg> sparkline per row
 *     when the question has ≥2 history points in the last 7 days
 *   - The sparkline svg carries an aria-label encoding the min and max spread
 *     observed in the 7-day window
 *
 * DoD items covered:
 *   #8  — Sparkline renders: each row with ≥2 history points has an <svg>
 *          (or <canvas>) with aria-label containing min and max spread values
 *   #9  — No sparkline for fresh question with exactly 1 history point:
 *          row shows a placeholder text (no <svg> / <canvas>)
 *   #10 — (Optional / skipped) Sparkline updates after cron tick — skipped because
 *          it requires Playwright timer manipulation that is inherently flaky.
 *          Document: if this behavior is needed, use a server-sent events or
 *          polling pattern and test it in a dedicated E2E suite with fake timers.
 *
 * Seed strategy:
 *   Questions are inserted via POST /api/test-seed-spreads (existing dev-only
 *   endpoint) for watched_questions + question_matches + spread_snapshots.
 *   History rows are seeded via a NEW POST /api/test-seed-history endpoint
 *   (to be implemented alongside the feature).
 *
 *   This spec calls that endpoint to insert history rows before the dashboard
 *   renders. Both endpoints clean up via POST /api/test-reset.
 *
 * Design decisions (document here so they survive the sprint):
 *   - The sparkline is an <svg> element (not <canvas>), co-located inside the
 *     WatchedRow component. canvas is also accepted — the test checks for either.
 *   - The sparkline aria-label format is: "Spread over last 7 days: min X.X%, max Y.Y%"
 *     This is the MINIMUM contract; the implementation may include more text.
 *   - When a question has <2 history points, the row shows a
 *     `data-testid="sparkline-placeholder"` element (or no sparkline element at all).
 *     Design choice: show nothing (no element) rather than an empty chart,
 *     to avoid confusing the user with a flat line that looks like "spread = 0".
 *
 * Authentication:
 *   Injects fixture session cookie (same pattern as tests/watched/dashboard-watched.spec.ts).
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { SESSION_A } from "../watched/helpers/fixture-watched";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const DASHBOARD_URL = `${BASE_URL}/dashboard`;

const FIXTURE_SESSION_TOKEN =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

/**
 * User A's ID — must match the fixture user seeded in queries.yaml
 * (00000000-0000-0000-0000-000000000001).
 */
const FIXTURE_USER_A_ID = "00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Fixture question definitions
// IDs use the 7xxxxxxx range to avoid collisions with other test suites.
// ---------------------------------------------------------------------------

/**
 * Question M — has 5 history points (spread values over 5 days).
 * Expected: sparkline <svg> with aria-label encoding min/max spread.
 */
const QM = {
  id: "70000000-0000-0000-0000-000000000001",
  query_text: "Will the ECB cut rates before Q4 2026? (sparkline multi-point)",
  spread: 0.04,
  platforms: {
    kalshi:     { matched: true,  market_url: "https://kalshi.com/markets/ecb-q4-2026",      implied_yes_prob: 0.38 },
    manifold:   { matched: true,  market_url: "https://manifold.markets/ecb-q4-2026",        implied_yes_prob: 0.42 },
    polymarket: { matched: false, market_url: null, implied_yes_prob: null },
    robinhood:  { matched: false, market_url: null, implied_yes_prob: null },
  },
  last_updated_offset_minutes: 2,
  /**
   * 5 history points over 5 consecutive days.
   * min spread = 0.02 (day 5 ago), max spread = 0.06 (day 1 ago).
   * The sparkline aria-label must encode these values.
   */
  history: [
    { spread: 0.02, days_ago: 5 },
    { spread: 0.03, days_ago: 4 },
    { spread: 0.04, days_ago: 3 },
    { spread: 0.05, days_ago: 2 },
    { spread: 0.06, days_ago: 1 },
  ],
} as const;

/**
 * Question N — has exactly 1 history point.
 * Expected: NO sparkline (or a placeholder), per the design decision above.
 *
 * Design choice documented: showing nothing (no svg/canvas) for <2 points
 * avoids a misleading flat line that looks like "spread = 0" or "spread = constant".
 */
const QN = {
  id: "70000000-0000-0000-0000-000000000002",
  query_text: "Will Bitcoin exceed $150k in 2026? (sparkline single-point)",
  spread: 0.025,
  platforms: {
    kalshi:     { matched: true,  market_url: "https://kalshi.com/markets/btc-150k-2026",    implied_yes_prob: 0.35 },
    manifold:   { matched: true,  market_url: "https://manifold.markets/btc-150k-2026",      implied_yes_prob: 0.375 },
    polymarket: { matched: false, market_url: null, implied_yes_prob: null },
    robinhood:  { matched: false, market_url: null, implied_yes_prob: null },
  },
  last_updated_offset_minutes: 1,
  /** Only 1 history point — no sparkline should render. */
  history: [
    { spread: 0.025, days_ago: 1 },
  ],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject the fixture user A session cookie into a Playwright context.
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
 * Seed spread fixture questions (watched_questions + question_matches + spread_snapshots)
 * via POST /api/test-seed-spreads. Existing pattern from dashboard-spreads.spec.ts.
 */
async function seedSpreadQuestions(
  page: Page,
  questions: Array<{
    id: string;
    query_text: string;
    spread: number | null;
    platforms: Record<
      string,
      { matched: boolean; market_url: string | null; implied_yes_prob: number | null }
    >;
    last_updated_offset_minutes: number;
  }>
): Promise<void> {
  const res = await page.request.post(`${BASE_URL}/api/test-seed-spreads`, {
    data: {
      questions: questions.map((q) => ({
        id: q.id,
        query_text: q.query_text,
        user_id: FIXTURE_USER_A_ID,
        spread: q.spread,
        last_updated_offset_minutes: q.last_updated_offset_minutes,
        platforms: q.platforms,
      })),
    },
  });

  if (!res.ok()) {
    throw new Error(
      `POST /api/test-seed-spreads failed: ${res.status()} ${await res.text()}`
    );
  }
}

/**
 * Seed spread_history rows via POST /api/test-seed-history.
 *
 * This endpoint does NOT YET EXIST — the call will fail (404 or network error)
 * until the feature is implemented. That failure causes the test to fail,
 * which is the correct pre-implementation behaviour.
 *
 * Expected request body:
 *   { history: [{ question_id, spread, days_ago }] }
 *
 * Expected response: { ok: true, seeded: N }
 */
async function seedHistoryRows(
  page: Page,
  entries: Array<{
    question_id: string;
    spread: number | null;
    days_ago: number;
  }>
): Promise<void> {
  const res = await page.request.post(`${BASE_URL}/api/test-seed-history`, {
    data: { history: entries },
  });

  if (!res.ok()) {
    throw new Error(
      `POST /api/test-seed-history failed with status ${res.status()}. ` +
        `This endpoint must be created alongside the spread_history feature. ` +
        `It writes directly to spread_history for each { question_id, spread, days_ago }. ` +
        `Response body: ${await res.text()}`
    );
  }
}

/**
 * Tear down all test data via POST /api/test-reset.
 */
async function resetTestData(page: Page): Promise<void> {
  await page.request.post(`${BASE_URL}/api/test-reset`).catch(() => {
    // Best-effort teardown
  });
}

/**
 * Navigate to /dashboard with the fixture session and wait for the page to load.
 */
async function goToDashboard(page: Page, context: BrowserContext): Promise<void> {
  await injectFixtureSession(context);
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
  // Wait for the watched-list region or empty state
  await page
    .getByRole("list")
    .or(page.getByText("You're not watching any questions yet."))
    .waitFor({ state: "visible", timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// DoD #8 — Sparkline renders for a question with ≥2 history points
// ---------------------------------------------------------------------------

test.describe("DoD #8 — Sparkline renders for ≥2 history points", () => {
  test.beforeEach(async ({ page, context }) => {
    await seedSpreadQuestions(page, [QM]);
    await seedHistoryRows(
      page,
      QM.history.map((h) => ({
        question_id: QM.id,
        spread: h.spread,
        days_ago: h.days_ago,
      }))
    );
    await goToDashboard(page, context);
  });

  test.afterEach(async ({ page }) => {
    await resetTestData(page);
  });

  test("dashboard row with 5 history points renders an <svg> or <canvas> sparkline", async ({
    page,
  }) => {
    // Locate the list item that contains the question text
    const row = page.locator("li").filter({
      hasText: QM.query_text,
    });

    await row.waitFor({ state: "visible", timeout: 10_000 });

    // The sparkline must be either an <svg> or a <canvas> inside the row
    const sparkline = row.locator("svg, canvas");

    await expect(
      sparkline.first(),
      `Expected an <svg> or <canvas> sparkline inside the row for "${QM.query_text}". ` +
        `No sparkline element found. ` +
        `Implement a Sparkline component that renders an <svg> (or <canvas>) ` +
        `inside WatchedRow when the question has ≥2 spread_history points in the last 7 days.`
    ).toBeVisible({ timeout: 10_000 });
  });

  test(
    "sparkline aria-label encodes min and max spread observed in the 7-day window",
    async ({ page }) => {
      const row = page.locator("li").filter({ hasText: QM.query_text });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      const sparkline = row.locator("svg, canvas").first();
      await expect(sparkline).toBeVisible({ timeout: 10_000 });

      const ariaLabel = await sparkline.getAttribute("aria-label");

      expect(
        ariaLabel,
        `Sparkline element has no aria-label. ` +
          `Set aria-label="Spread over last 7 days: min X.X%, max Y.Y%" ` +
          `(or similar) so screen readers can convey the sparkline range. ` +
          `Min spread for QM: 2.0%, max spread: 6.0%.`
      ).not.toBeNull();

      // aria-label must contain "min" and "max" (case-insensitive)
      expect(
        ariaLabel?.toLowerCase(),
        `Sparkline aria-label="${ariaLabel}" does not contain the word "min". ` +
          `Required format (example): "Spread over last 7 days: min 2.0%, max 6.0%".`
      ).toContain("min");

      expect(
        ariaLabel?.toLowerCase(),
        `Sparkline aria-label="${ariaLabel}" does not contain the word "max". ` +
          `Required format (example): "Spread over last 7 days: min 2.0%, max 6.0%".`
      ).toContain("max");

      // aria-label must contain a numeric representation of the min spread (2.0 or 2%)
      expect(
        ariaLabel,
        `Sparkline aria-label="${ariaLabel}" does not mention the min spread value (2.0% or "2"). ` +
          `The min spread for QM's history is 2.0%. ` +
          `Encode the actual numeric min and max in the aria-label.`
      ).toMatch(/2[.,]?0?%/);

      // aria-label must contain a numeric representation of the max spread (6.0 or 6%)
      expect(
        ariaLabel,
        `Sparkline aria-label="${ariaLabel}" does not mention the max spread value (6.0% or "6"). ` +
          `The max spread for QM's history is 6.0%. ` +
          `Encode the actual numeric min and max in the aria-label.`
      ).toMatch(/6[.,]?0?%/);
    }
  );
});

// ---------------------------------------------------------------------------
// DoD #9 — No sparkline when <2 history points
// ---------------------------------------------------------------------------

test.describe("DoD #9 — No sparkline for a question with <2 history points", () => {
  /**
   * Design decision (documented per task brief):
   *   When a question has fewer than 2 history points, the WatchedRow renders
   *   NO sparkline element (no <svg>, no <canvas>).
   *
   *   Rationale: a single-point "sparkline" is a flat line that could mislead
   *   the user into thinking the spread is constant. Showing nothing is less
   *   confusing. The row still shows the current spread value from spread_snapshots.
   *
   *   Alternative considered: show a placeholder with text "Not enough data yet".
   *   Rejected because it takes up visual space for a transient state (new questions
   *   will accumulate history within a day). The simpler choice is to omit the chart.
   *
   *   If the implementation team chooses to render a placeholder element instead,
   *   this test must be updated to assert the placeholder is visible AND that no
   *   <svg>/<canvas> sparkline chart is rendered (to avoid a misleading flat line).
   */

  test.beforeEach(async ({ page, context }) => {
    await seedSpreadQuestions(page, [QN]);
    await seedHistoryRows(
      page,
      QN.history.map((h) => ({
        question_id: QN.id,
        spread: h.spread,
        days_ago: h.days_ago,
      }))
    );
    await goToDashboard(page, context);
  });

  test.afterEach(async ({ page }) => {
    await resetTestData(page);
  });

  test(
    "dashboard row with only 1 history point does NOT render an <svg> or <canvas> sparkline",
    async ({ page }) => {
      const row = page.locator("li").filter({ hasText: QN.query_text });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      // Assert no <svg> or <canvas> sparkline is rendered inside this row
      const sparkline = row.locator("svg, canvas");
      const count = await sparkline.count();

      expect(
        count,
        `Expected no sparkline element inside the row for "${QN.query_text}" ` +
          `(only 1 history point — not enough to draw a chart). ` +
          `Found ${count} sparkline element(s). ` +
          `Render a sparkline only when the question has ≥2 history points in the last 7 days. ` +
          `If a placeholder is shown instead, update this test to assert the placeholder ` +
          `is visible and the sparkline chart is absent.`
      ).toBe(0);
    }
  );
});

// ---------------------------------------------------------------------------
// DoD #10 — Skipped: sparkline update after cron tick
// ---------------------------------------------------------------------------

test.describe("DoD #10 — Sparkline update after cron tick (skipped)", () => {
  /**
   * This test is intentionally skipped.
   *
   * Rationale (documented per task brief):
   *   Testing that the sparkline re-renders after a real cron tick requires
   *   either:
   *     (a) Playwright timer manipulation (page.clock.tick or vi.advanceTimersByTime),
   *         which is flaky when combined with React hydration and SSE/polling latency.
   *     (b) A dedicated E2E environment with a controllable cron trigger, which is
   *         outside the scope of this sprint.
   *
   *   If the sparkline is updated via client-side polling (e.g., every 5 min),
   *   test it in a separate suite with Playwright's clock API and a mock API endpoint.
   *
   *   If the sparkline is server-rendered (SSR on each page load), the update
   *   behaviour is already covered by the seed → navigate pattern in DoD #8.
   */
  test.skip("sparkline updates after a cron tick (intentionally skipped — see comment)", () => {
    // Not implemented — see rationale in the describe block above.
  });
});
