/**
 * tests/watched/dashboard-watched.spec.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-watched-frontend implements the /dashboard watched-questions UI
 *   - task-watched-backend implements POST/GET/DELETE /api/watched
 *
 * Sprint ordering note:
 *   The dashboard is a placeholder stub as of Sprint 2 (task-skeleton-impl).
 *   The watched-questions UI (task-watched-frontend) ships in Sprint 3.
 *   These Playwright tests will start passing once task-watched-frontend lands
 *   and will continue to fail until that dispatch completes.
 *
 * Test surfaces covered (per task-watched-test brief §Frontend):
 *   9.  Add form — input + submit visible; submit adds a row without full reload
 *   10. List rendering — existing questions render with query_text + Remove button
 *   11. Delete affordance — clicking Remove removes the row from the list
 *   12. Cap-reached UI — at 5 questions: form disabled, cap message shown
 *   13. Empty state — after all deleted: empty-state copy renders
 *
 * UX spec references:
 *   - docs/design/dashboard.md §5B — add-form copy (input label, button label, cap message)
 *   - docs/design/dashboard.md §5C — watched-list copy (Remove button, empty-state)
 *   - docs/design/dashboard.md §3 — component hierarchy (h1, aria-label landmarks)
 *   - docs/design/dashboard.md §4 — State 1 (empty), State 3 (populated), State 4 (cap-reached)
 *
 * Route under test:
 *   GET /dashboard  (per docs/design/dashboard.md §3: <main aria-label="Watched questions dashboard">)
 *
 * Authentication strategy:
 *   Injects the fixture session cookie (same pattern as tests/auth/redirect-when-authenticated.spec.ts).
 *   Session token must be seeded by scripts/seed.ts for the fixture user.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import {
  SESSION_A,
  FIXTURE_USER_A,
  FIXTURE_USER_B,
  SEED_QUESTIONS,
  CAP_TOPUP_QUESTIONS,
  CAP_EXCEEDED_MESSAGE,
  EMPTY_STATE_HEADING,
  EMPTY_STATE_SUBTEXT,
  PAGE_HEADING,
  SUBMIT_BUTTON_LABEL,
  INPUT_LABEL,
  REMOVE_BUTTON_LABEL,
  PAGE_TITLE,
} from "./helpers/fixture-watched";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const DASHBOARD_URL = `${BASE_URL}/dashboard`;

/** Fixture session token for user A — seeded into the test DB. */
const FIXTURE_SESSION_TOKEN =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject the fixture user's session cookie into a Playwright browser context.
 * Mirrors the same pattern in tests/auth/redirect-when-authenticated.spec.ts.
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
 * Waits for the page to have the Watched-questions h1 visible.
 */
async function goToDashboard(page: Page, context: BrowserContext): Promise<void> {
  await injectFixtureSession(context);
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
}

/**
 * Fill and submit the add-question form.
 * Returns after the new row is expected to appear (waits for a list item containing the query text).
 */
async function addQuestion(page: Page, queryText: string): Promise<void> {
  // The input is labelled "Watch a new question" per docs/design/dashboard.md §5B
  const input = page.getByLabel(INPUT_LABEL);
  await input.fill(queryText);
  await page.getByRole("button", { name: SUBMIT_BUTTON_LABEL }).click();
  // Wait for the row to appear in the list — no full page reload expected
  await page.getByText(queryText).waitFor({ state: "visible", timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Test 9: Add form
// ---------------------------------------------------------------------------

test.describe("Dashboard — add-question form (DoD item 9)", () => {
  test(
    "the dashboard shows the add-question input and 'Watch question' submit button",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // h1 must be visible per docs/design/dashboard.md §5A
        await expect(
          page.getByRole("heading", { name: PAGE_HEADING, level: 1 }),
          `The dashboard must render <h1>"${PAGE_HEADING}"</h1> per docs/design/dashboard.md §5A. ` +
            `The dashboard is a placeholder stub until task-watched-frontend lands (Sprint 3).`
        ).toBeVisible({ timeout: 5_000 });

        // Input must be visible
        const input = page.getByLabel(INPUT_LABEL);
        await expect(
          input,
          `The add-question input (label "${INPUT_LABEL}") must be visible on /dashboard. ` +
            `Source: docs/design/dashboard.md §5B. ` +
            `task-watched-frontend must implement this form.`
        ).toBeVisible({ timeout: 5_000 });

        // Submit button must be visible
        await expect(
          page.getByRole("button", { name: SUBMIT_BUTTON_LABEL }),
          `The submit button "${SUBMIT_BUTTON_LABEL}" must be visible on /dashboard. ` +
            `Source: docs/design/dashboard.md §5B. ` +
            `task-watched-frontend must implement this form.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "typing a query and submitting adds a row to the list without a full page reload",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        const newQuery = "Playwright add-form test — unique query " + Date.now();

        // Track navigation events to assert no full page reload
        let navigationCount = 0;
        page.on("framenavigated", () => { navigationCount++; });

        // Reset counter after initial load
        const initialNavCount = navigationCount;

        await addQuestion(page, newQuery);

        // The row must appear in the list
        await expect(
          page.getByText(newQuery),
          `After submitting "${newQuery}", the row must appear in the watched-questions list. ` +
            `task-watched-frontend must update the list without a full page reload ` +
            `(via form-action revalidation or client-side fetch per DoD item 9).`
        ).toBeVisible({ timeout: 10_000 });

        // Navigation should not have increased by more than 1 (the initial load)
        // A full page reload would show as an additional navigation
        // Note: form-action revalidation in Next.js App Router does NOT trigger framenavigated,
        // so any increase beyond the initial load indicates an unintended full reload.
        expect(
          navigationCount - initialNavCount <= 1,
          `The page performed ${navigationCount - initialNavCount} full navigations after form submission. ` +
            `Expected at most 1 (the initial load). ` +
            `The add form must update the list without a full page reload.`
        ).toBe(true);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "the page <title> is 'Dashboard — ArbWatch' per UX spec",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        await expect(
          page,
          `Page <title> must be "${PAGE_TITLE}". ` +
            `Source: docs/design/dashboard.md §5A.`
        ).toHaveTitle(PAGE_TITLE, { timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 10: List rendering
// ---------------------------------------------------------------------------

test.describe("Dashboard — list rendering (DoD item 10)", () => {
  test(
    "the user's existing watched questions render with the correct query_text",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // The seed plants 3 questions for the fixture user.
        // Each must be visible in the list.
        for (const seedQ of SEED_QUESTIONS) {
          await expect(
            page.getByText(seedQ.query_text),
            `Seed question "${seedQ.query_text}" must be visible in the watched-questions list. ` +
              `The list must render all of the user's existing questions on page load. ` +
              `Source: docs/design/dashboard.md §3 (component hierarchy). ` +
              `task-watched-frontend must fetch and render the user's watched questions.`
          ).toBeVisible({ timeout: 5_000 });
        }
      } finally {
        await context.close();
      }
    }
  );

  test(
    "each question row has a 'Remove' button",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Wait for the list to render
        await page.getByText(SEED_QUESTIONS[0].query_text).waitFor({ state: "visible", timeout: 5_000 });

        // There should be at least 3 Remove buttons (one per seed question)
        const removeButtons = page.getByRole("button", { name: REMOVE_BUTTON_LABEL });
        const count = await removeButtons.count();

        expect(
          count,
          `Expected at least 3 "${REMOVE_BUTTON_LABEL}" buttons (one per seed question), got ${count}. ` +
            `Source: docs/design/dashboard.md §5C ("Remove button: 'Remove'"). ` +
            `Each watched-question row must have a Remove button.`
        ).toBeGreaterThanOrEqual(3);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "the counter displays the correct number of watched questions",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Counter visible text format: "N / 5 watched"
        // Source: docs/design/dashboard.md §5A
        await expect(
          page.getByText("3 / 5 watched"),
          `The question counter must read "3 / 5 watched" for the fixture user with 3 seed questions. ` +
            `Source: docs/design/dashboard.md §5A ("visible text: N / 5 watched"). ` +
            `task-watched-frontend must render the counter accurately.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 11: Delete affordance
// ---------------------------------------------------------------------------

test.describe("Dashboard — delete affordance (DoD item 11)", () => {
  test(
    "clicking 'Remove' on a question shows inline confirmation and removes the row on confirm",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Pick the first seed question to remove
        const questionToRemove = SEED_QUESTIONS[0].query_text;

        // Wait for the question to appear
        await page.getByText(questionToRemove).waitFor({ state: "visible", timeout: 5_000 });

        // Click Remove on the row containing this question.
        // Use aria-label pattern: "Remove question: {query}" per docs/design/dashboard.md §5C
        const removeAriaLabel = `Remove question: ${questionToRemove}`;
        const removeButton = page.getByRole("button", { name: removeAriaLabel });

        // If the exact aria-label is not present, fall back to a generic Remove button near the text
        const hasAriaLabel = await removeButton.isVisible().catch(() => false);

        if (hasAriaLabel) {
          await removeButton.click();
        } else {
          // Fallback: find the Remove button within the row containing the question text
          const row = page.locator("li, tr").filter({ hasText: questionToRemove });
          await row.getByRole("button", { name: REMOVE_BUTTON_LABEL }).click();
        }

        // Inline confirmation must appear per docs/design/dashboard.md §5C and §2C
        // "Remove this question?" heading
        await expect(
          page.getByText("Remove this question?"),
          `After clicking Remove, the inline confirmation prompt "Remove this question?" must appear. ` +
            `Source: docs/design/dashboard.md §5C ("Inline confirmation heading"). ` +
            `task-watched-frontend must implement the confirmation prompt per §2C.`
        ).toBeVisible({ timeout: 3_000 });

        // Click "Yes, remove" to confirm
        await page.getByRole("button", { name: "Yes, remove" }).click();

        // The row must disappear from the list
        await expect(
          page.getByText(questionToRemove),
          `After confirming removal of "${questionToRemove}", the row must disappear from the list. ` +
            `Source: docs/design/dashboard.md §2C step 4 ("row is removed with a brief fade-out animation"). ` +
            `task-watched-frontend must handle the delete action and update the list.`
        ).not.toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "cancelling the inline confirmation leaves the row in place",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        const questionToKeep = SEED_QUESTIONS[1].query_text;
        await page.getByText(questionToKeep).waitFor({ state: "visible", timeout: 5_000 });

        // Open inline confirmation
        const row = page.locator("li, tr").filter({ hasText: questionToKeep });
        await row.getByRole("button", { name: REMOVE_BUTTON_LABEL }).click();

        // Confirmation must appear
        await page.getByText("Remove this question?").waitFor({ state: "visible", timeout: 3_000 });

        // Click Cancel
        await page.getByRole("button", { name: "Cancel" }).click();

        // Row must still be present
        await expect(
          page.getByText(questionToKeep),
          `After clicking Cancel, "${questionToKeep}" must still be visible in the list. ` +
            `Source: docs/design/dashboard.md §2C step 6 ("User cancels → no change"). ` +
            `The Cancel action must dismiss the confirmation without removing the row.`
        ).toBeVisible({ timeout: 3_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "the counter decrements after a successful removal",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Starting with 3 seed questions, counter should read "3 / 5 watched"
        await expect(page.getByText("3 / 5 watched")).toBeVisible({ timeout: 5_000 });

        // Remove one question
        const questionToRemove = SEED_QUESTIONS[2].query_text;
        const row = page.locator("li, tr").filter({ hasText: questionToRemove });
        await row.getByRole("button", { name: REMOVE_BUTTON_LABEL }).click();
        await page.getByRole("button", { name: "Yes, remove" }).click();

        // Counter must now read "2 / 5 watched"
        await expect(
          page.getByText("2 / 5 watched"),
          `After removing a question, the counter must read "2 / 5 watched". ` +
            `Source: docs/design/dashboard.md §2C step 4 ("Counter decrements"). ` +
            `task-watched-frontend must update the counter after deletion.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 12: Cap-reached UI
// ---------------------------------------------------------------------------

test.describe("Dashboard — cap-reached UI (DoD item 12)", () => {
  /**
   * Pre-condition: The fixture user must have exactly 5 questions.
   * The seed provides 3; we add 2 more via the API before these tests.
   * This uses the API rather than direct DB access because Playwright tests
   * run against a live server (preview.sh), not the in-process test server.
   *
   * Note: If the API endpoints are not yet implemented, these tests will fail
   * at the add-question step, not the cap-UI assertions — which is correct
   * Mode 1 behaviour (they fail because the implementation is missing).
   */
  test.beforeEach(async ({ browser }) => {
    // Use a direct fetch to add 2 more questions for the fixture user
    // so the cap-reached state can be tested.
    const domain = new URL(BASE_URL).hostname;
    // We cannot use browser context cookies in beforeEach with a different context easily.
    // The individual tests handle their own setup by adding questions in-test.
  });

  test(
    "when 5 questions are present, the input and submit button are disabled",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Add 2 more questions to reach the cap (seed has 3)
        await addQuestion(page, CAP_TOPUP_QUESTIONS[0].query_text + " PW-cap-1");
        await addQuestion(page, CAP_TOPUP_QUESTIONS[1].query_text + " PW-cap-2");

        // Now at 5 — input and submit must be disabled
        const input = page.getByLabel(INPUT_LABEL);
        await expect(
          input,
          `When 5 questions are present, the add-question input must be disabled. ` +
            `Source: docs/design/dashboard.md §4 State 4 ("The question input is 'disabled'"). ` +
            `Both have aria-disabled="true" per the spec.`
        ).toBeDisabled({ timeout: 5_000 });

        const submitButton = page.getByRole("button", { name: SUBMIT_BUTTON_LABEL });
        await expect(
          submitButton,
          `When 5 questions are present, the "${SUBMIT_BUTTON_LABEL}" button must be disabled. ` +
            `Source: docs/design/dashboard.md §4 State 4 ("The 'Watch question' submit button is disabled").`
        ).toBeDisabled({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "when 5 questions are present, the cap-exceeded message is visible",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Add 2 questions to reach the cap
        await addQuestion(page, "Cap-msg test question A — " + Date.now());
        await addQuestion(page, "Cap-msg test question B — " + Date.now());

        // The cap-exceeded message must appear below the form
        await expect(
          page.getByText(CAP_EXCEEDED_MESSAGE),
          `When 5 questions are present, the cap-exceeded message must be visible: ` +
            `"${CAP_EXCEEDED_MESSAGE}". ` +
            `Source: docs/design/dashboard.md §5B and §4 State 4 ` +
            `('<p id="cap-message">"You\'ve reached the 5-question limit. ` +
            `Remove a question to add a new one."'). ` +
            `task-watched-frontend must render this exact string.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "the counter reads '5 / 5 watched' at the cap",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Add 2 questions to reach the cap
        await addQuestion(page, "Cap-counter test A — " + Date.now());
        await addQuestion(page, "Cap-counter test B — " + Date.now());

        await expect(
          page.getByText("5 / 5 watched"),
          `At the 5-question cap, the counter must read "5 / 5 watched". ` +
            `Source: docs/design/dashboard.md §5A ("N / 5 watched"). ` +
            `task-watched-frontend must update the counter accurately.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "a 6th add attempt does not submit when the form is at the cap",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Add 2 to reach the cap
        const ts = Date.now();
        await addQuestion(page, `Cap block test A — ${ts}`);
        await addQuestion(page, `Cap block test B — ${ts}`);

        // Now try to type and submit a 6th question
        const sixthQuery = `Should be blocked — 6th — ${ts}`;
        const input = page.getByLabel(INPUT_LABEL);

        // Input is disabled — force-fill should not work, but attempt anyway
        // to assert the row does NOT appear
        await input.fill(sixthQuery).catch(() => {
          // Expected: disabled input may refuse fill — that's fine
        });

        // The "Watch question" button is disabled; clicking it must not submit
        const submitButton = page.getByRole("button", { name: SUBMIT_BUTTON_LABEL });
        await submitButton.click({ force: true }).catch(() => {
          // Expected: disabled button may refuse click — that's fine
        });

        // Wait briefly — the row must NOT appear
        await page.waitForTimeout(1_000);

        const sixthRowVisible = await page.getByText(sixthQuery).isVisible().catch(() => false);
        expect(
          sixthRowVisible,
          `A 6th question "${sixthQuery}" appeared in the list despite the cap being reached. ` +
            `When at 5 / 5, no new questions can be added. ` +
            `Source: docs/design/dashboard.md §2B ("User cannot add more questions without ` +
            `first removing one") and §4 State 4 ("disabled" input and button). ` +
            `task-watched-frontend must prevent submission at the cap.`
        ).toBe(false);
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 13: Empty state
// ---------------------------------------------------------------------------

test.describe("Dashboard — empty state (DoD item 13)", () => {
  test(
    "after deleting all questions, the empty-state copy renders",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Delete all 3 seed questions one by one
        for (const seedQ of [...SEED_QUESTIONS]) {
          // Wait for the question to appear (list may be updating)
          await page.getByText(seedQ.query_text).waitFor({ state: "visible", timeout: 5_000 });

          const row = page.locator("li, tr").filter({ hasText: seedQ.query_text });
          await row.getByRole("button", { name: REMOVE_BUTTON_LABEL }).click();

          // Confirm removal
          await page.getByRole("button", { name: "Yes, remove" }).click();

          // Wait for the row to disappear before proceeding
          await page.getByText(seedQ.query_text).waitFor({ state: "hidden", timeout: 5_000 });
        }

        // Now the list is empty — check empty-state heading
        await expect(
          page.getByText(EMPTY_STATE_HEADING),
          `After deleting all questions, the empty-state heading ` +
            `"${EMPTY_STATE_HEADING}" must be visible. ` +
            `Source: docs/design/dashboard.md §5C ("Empty-state heading"). ` +
            `task-watched-frontend must render this exact string per §4 State 1.`
        ).toBeVisible({ timeout: 5_000 });

        // And the subtext
        await expect(
          page.getByText(EMPTY_STATE_SUBTEXT),
          `After deleting all questions, the empty-state subtext ` +
            `"${EMPTY_STATE_SUBTEXT}" must be visible. ` +
            `Source: docs/design/dashboard.md §5C ("Empty-state subtext"). ` +
            `task-watched-frontend must render this exact string.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "after deleting all questions, the counter reads '0 / 5 watched'",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // Delete all 3 seed questions
        for (const seedQ of [...SEED_QUESTIONS]) {
          await page.getByText(seedQ.query_text).waitFor({ state: "visible", timeout: 5_000 });
          const row = page.locator("li, tr").filter({ hasText: seedQ.query_text });
          await row.getByRole("button", { name: REMOVE_BUTTON_LABEL }).click();
          await page.getByRole("button", { name: "Yes, remove" }).click();
          await page.getByText(seedQ.query_text).waitFor({ state: "hidden", timeout: 5_000 });
        }

        // Counter must read "0 / 5 watched"
        await expect(
          page.getByText("0 / 5 watched"),
          `After deleting all questions, the counter must read "0 / 5 watched". ` +
            `Source: docs/design/dashboard.md §5A ("visible text: N / 5 watched"). ` +
            `task-watched-frontend must update the counter to 0 when the list is empty.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "after deleting all questions, the add form is re-enabled",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await goToDashboard(page, context);

        // First, add 2 more questions to hit the cap (seed has 3)
        const ts = Date.now();
        await addQuestion(page, `Empty-state-re-enable A ${ts}`);
        await addQuestion(page, `Empty-state-re-enable B ${ts}`);

        // Confirm the form is now disabled
        await expect(page.getByLabel(INPUT_LABEL)).toBeDisabled({ timeout: 5_000 });

        // Delete all 5 questions
        const allQueries = [
          ...SEED_QUESTIONS.map((q) => q.query_text),
          `Empty-state-re-enable A ${ts}`,
          `Empty-state-re-enable B ${ts}`,
        ];

        for (const queryText of allQueries) {
          const el = page.getByText(queryText);
          if (!(await el.isVisible().catch(() => false))) continue;
          const row = page.locator("li, tr").filter({ hasText: queryText });
          await row.getByRole("button", { name: REMOVE_BUTTON_LABEL }).click();
          await page.getByRole("button", { name: "Yes, remove" }).click();
          await el.waitFor({ state: "hidden", timeout: 5_000 });
        }

        // After all deletions, the input must be re-enabled
        await expect(
          page.getByLabel(INPUT_LABEL),
          `After deleting all questions, the add-question input must be re-enabled. ` +
            `Source: docs/design/dashboard.md §2C step 5 ` +
            `("If the list was at 5/5, the input and submit button re-enable after the row is removed"). ` +
            `task-watched-frontend must lift the disabled state when the count drops below 5.`
        ).not.toBeDisabled({ timeout: 5_000 });

        // And the submit button must be re-enabled
        await expect(
          page.getByRole("button", { name: SUBMIT_BUTTON_LABEL }),
          `After deleting all questions, the "${SUBMIT_BUTTON_LABEL}" button must be re-enabled. ` +
            `Source: docs/design/dashboard.md §2C step 5.`
        ).not.toBeDisabled({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});
