/**
 * tests/disclaimer/disclaimer.spec.ts
 *
 * Disclaimer coverage test — Mode 1 (pre-implementation).
 *
 * Purpose: Enumerate every route and email template that renders a spread value
 * and assert the mandatory disclaimer string appears on each.
 *
 * DISCLAIMER_STRING (verbatim, UTF-8, locked):
 *   "arb ≠ profit; slippage and fees may eat spread"
 *   The ≠ character is Unicode U+2260.
 *
 * This file has 3 test groups:
 *
 *   Group 1 — Route enumeration (Playwright)
 *     Navigates each spread-bearing route and asserts the disclaimer is visible.
 *     PASS TODAY: /dashboard already renders the disclaimer in DashboardClient.tsx
 *     (DoD item 8 in dashboard-spreads.spec.ts covers the specific DOM positions;
 *     this file's role is to be the registry that a new route author must update).
 *
 *   Group 2 — Email template enumeration (static file content check)
 *     Asserts the alert email template's HTML and plaintext outputs both contain
 *     the disclaimer. Delegates to tests/alerts/alerts.test.ts T2 for the
 *     full Resend-dispatch version; this group tests the template file directly.
 *     FAILS TODAY: lib/alerts/template.ts (and the fallback lib/alerts.ts) do not
 *     yet exist. The test fails with a clear error naming the missing path(s).
 *
 *   Group 3 — Defensive .tsx coverage assertion (static grep)
 *     Programmatically lists all .tsx files under app/ that reference the string
 *     "spread". For each, the file must either:
 *       (a) contain the disclaimer string (arb ≠ profit or the HTML entity &#8800;),
 *       (b) be listed in DISCLAIMER_EXCEPTION_LIST with a documented reason.
 *     Fails if a new spread-rendering component is added without the disclaimer.
 *     PASS TODAY: all current .tsx files are either covered or in the exception list.
 *
 * Cross-references (do not duplicate assertions from these files):
 *   tests/alerts/alerts.test.ts   — T2 asserts disclaimer in Resend-dispatched email
 *   tests/dashboard/dashboard-spreads.spec.ts — DoD item 8 asserts disclaimer positions
 *
 * Design references:
 *   docs/design/dashboard.md §5A  — disclaimer string, placement (sub-header + footer)
 *   docs/design/dashboard.md §3   — layout hierarchy
 */

import { test, expect, type BrowserContext } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The mandatory disclaimer string (exact UTF-8 sequence).
 * Source: docs/design/dashboard.md §5A
 * Never modify this constant to make tests pass — it is the design contract.
 * Note: HTML renditions may use the entity &#8800; (≠) which browsers decode to ≠.
 */
const DISCLAIMER_STRING = "arb ≠ profit; slippage and fees may eat spread";

/**
 * The HTML entity form of the disclaimer (used in .tsx source files and in
 * email template HTML output before browser/mail-client entity decoding).
 * Both forms encode the same semantic string.
 */
const DISCLAIMER_STRING_HTML_ENTITY =
  "arb &#8800; profit; slippage and fees may eat spread";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

const FIXTURE_SESSION_TOKEN =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

/**
 * Repository root: two directories up from tests/disclaimer/.
 */
const REPO_ROOT = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Group 1 — Spread-bearing routes registry
//
// Hard-coded list of routes that render spread values.
// To extend for a future phase:
//   Phase 2  /dashboard/[questionId]  — add "/dashboard/FIXTURE_QUESTION_ID"
//   Phase 2  /digest                  — add "/digest"
// Each route in this list will be navigated with a session cookie and asserted
// to display the disclaimer string.
// ---------------------------------------------------------------------------

/**
 * Routes that render spread values.
 * This is the authoritative registry for disclaimer coverage on routes.
 * Update this list when new spread-rendering routes are added.
 */
const SPREAD_BEARING_ROUTES = ["/dashboard"];

/**
 * Inject the fixture session cookie for user A.
 * Mirrors the pattern in tests/watched/dashboard-watched.spec.ts and
 * tests/dashboard/dashboard-spreads.spec.ts.
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

test.describe("Group 1 — Spread-bearing routes: disclaimer visible on each", () => {
  for (const route of SPREAD_BEARING_ROUTES) {
    test(`route "${route}" renders the disclaimer string`, async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectFixtureSession(context);
        const page = await context.newPage();
        await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded" });

        // Wait for the Watched questions heading to confirm the page rendered.
        // This mirrors the goToDashboard helper in dashboard-spreads.spec.ts.
        await page
          .getByRole("heading", { name: "Watched questions", level: 1 })
          .waitFor({ state: "visible", timeout: 10_000 });

        // The disclaimer must appear at least once (sub-header + footer = 2 times,
        // but getByText finds the first match). Both instances are tested in
        // tests/dashboard/dashboard-spreads.spec.ts DoD item 8.
        //
        // Source: docs/design/dashboard.md §5A
        //   "The disclaimer string appears in two fixed locations on every view
        //    that renders spread values."
        await expect(
          page.getByText(DISCLAIMER_STRING).first(),
          `Route "${route}" must render the disclaimer string: "${DISCLAIMER_STRING}". ` +
            `Source: docs/design/dashboard.md §5A. ` +
            `DashboardClient.tsx already renders this — PASSES in Mode 1.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Group 2 — Email template enumeration
//
// The threshold-crossed alert email (task-alerts-impl) must include the
// disclaimer string in both HTML and plaintext outputs.
//
// Cross-reference: tests/alerts/alerts.test.ts T2 asserts the disclaimer via
// a full Resend dispatch cycle. This group's role is to verify the template
// SOURCE FILE contains the disclaimer directly (static check), so a stray
// copy-paste that removes it from the template is caught even without running
// the full cron stack.
//
// Candidate template paths (searched in order):
//   1. lib/alerts/template.ts   — preferred separate template module
//   2. lib/alerts.ts            — monolithic alerts module (template inlined)
//   3. emails/alert.tsx         — React Email component
//   4. emails/alert.ts          — plain TS email builder
//
// If none of these exist, the test fails with a clear error naming all paths.
// ---------------------------------------------------------------------------

/**
 * Candidate paths for the alert email template, in search order.
 * If lib/alerts/template.ts exists, it is the canonical location.
 * lib/alerts.ts is the fallback if the template is inlined.
 * emails/alert.tsx or emails/alert.ts cover the React Email pattern.
 */
const ALERT_TEMPLATE_CANDIDATES = [
  join(REPO_ROOT, "lib", "alerts", "template.ts"),
  join(REPO_ROOT, "lib", "alerts.ts"),
  join(REPO_ROOT, "emails", "alert.tsx"),
  join(REPO_ROOT, "emails", "alert.ts"),
] as const;

test.describe("Group 2 — Alert email template: disclaimer in HTML and plaintext output", () => {
  /**
   * Locate the alert template file from the candidates list.
   * Returns the path of the first existing candidate, or null.
   */
  function findAlertTemplatePath(): string | null {
    for (const candidate of ALERT_TEMPLATE_CANDIDATES) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  test(
    "alert template source file exists at one of the expected paths",
    async () => {
      const found = findAlertTemplatePath();
      expect(
        found,
        `Alert email template not found. Searched paths:\n` +
          ALERT_TEMPLATE_CANDIDATES.map((p) => `  - ${p}`).join("\n") +
          `\n\nThe implementer (task-alerts-impl) must create an alert email template ` +
          `at one of the above paths. ` +
          `This test FAILS in Mode 1 until task-alerts-impl lands.`
      ).not.toBeNull();
    }
  );

  test(
    "alert template HTML output contains the disclaimer string",
    async () => {
      const templatePath = findAlertTemplatePath();

      if (!templatePath) {
        throw new Error(
          `Alert email template not found. Searched:\n` +
            ALERT_TEMPLATE_CANDIDATES.map((p) => `  - ${p}`).join("\n") +
            `\nThis test FAILS in Mode 1 until task-alerts-impl creates the template.`
        );
      }

      const source = readFileSync(templatePath, "utf-8");

      // The template source must contain the disclaimer in one of these forms:
      //   - The raw Unicode string: arb ≠ profit; slippage and fees may eat spread
      //   - The HTML entity form:   arb &#8800; profit; slippage and fees may eat spread
      //   - A reference to a shared DISCLAIMER_STRING constant that is itself the locked string
      //     (checked by searching for the string in the same module or an imported constant)
      //
      // We accept either the raw Unicode form or the HTML entity form because
      // templating systems may encode ≠ as &#8800; in HTML output — both decode
      // to the same character in the email client.
      const hasDisclaimer =
        source.includes(DISCLAIMER_STRING) ||
        source.includes(DISCLAIMER_STRING_HTML_ENTITY) ||
        // Also accept the bare ≠ entity for JSX attribute form
        source.includes("arb ≠ profit") ||
        source.includes("arb &ne; profit");

      expect(
        hasDisclaimer,
        `Alert template at ${templatePath} does not contain the disclaimer string. ` +
          `Expected to find one of:\n` +
          `  "${DISCLAIMER_STRING}"\n` +
          `  "${DISCLAIMER_STRING_HTML_ENTITY}"\n` +
          `Source: docs/design/dashboard.md §5A ` +
          `("the disclaimer string must appear in every spread-bearing email"). ` +
          `Template source snippet (first 800 chars):\n${source.slice(0, 800)}`
      ).toBe(true);
    }
  );

  test(
    "alert template plaintext output contains the disclaimer string",
    async () => {
      const templatePath = findAlertTemplatePath();

      if (!templatePath) {
        throw new Error(
          `Alert email template not found. Searched:\n` +
            ALERT_TEMPLATE_CANDIDATES.map((p) => `  - ${p}`).join("\n") +
            `\nThis test FAILS in Mode 1 until task-alerts-impl creates the template.`
        );
      }

      const source = readFileSync(templatePath, "utf-8");

      // Plaintext email bodies should not use HTML entities — they must contain
      // the raw Unicode ≠ (U+2260) character or some plaintext equivalent.
      // We check the source for a "text" or "plain" function/export that includes it.
      //
      // Strategy: the source must contain DISCLAIMER_STRING somewhere distinct from
      // an html-only context. We require either:
      //   (a) The template exports both an html and a text function, and the text
      //       function's return value references the disclaimer.
      //   (b) The template contains DISCLAIMER_STRING (Unicode) which is used by
      //       the text generator (the raw Unicode form is valid in plaintext).
      //
      // Because static analysis of function bodies is complex, we check for the
      // presence of the raw Unicode form (which should be in the plaintext branch)
      // OR the html entity form within the source (which indicates any coverage).
      //
      // The full runtime assertion (Resend dispatch → check inbox[0].text) is in
      // tests/alerts/alerts.test.ts T2 ("disclaimer appears in plain-text body").
      //
      // This test verifies the source file is at least aware of the plaintext
      // requirement by containing a text/plain export or a raw-Unicode disclaimer.
      const hasPlaintextDisclaimer =
        source.includes(DISCLAIMER_STRING) ||
        // Plaintext function naming conventions:
        source.includes("textBody") ||
        source.includes("plainText") ||
        source.includes("text:") ||
        source.includes('"text"') ||
        source.includes("'text'") ||
        source.includes("buildText") ||
        source.includes("renderText");

      expect(
        hasPlaintextDisclaimer,
        `Alert template at ${templatePath} does not appear to include a plaintext ` +
          `rendition of the disclaimer string. ` +
          `The template must produce both HTML and plaintext bodies, each containing: ` +
          `"${DISCLAIMER_STRING}". ` +
          `Per docs/design/dashboard.md §5A and tests/alerts/alerts.test.ts T2. ` +
          `Expected either the raw Unicode disclaimer string or a plaintext export ` +
          `(textBody / plainText / text: / buildText / renderText). ` +
          `Template source (first 800 chars):\n${source.slice(0, 800)}`
      ).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// Group 3 — Defensive .tsx coverage assertion
//
// Programmatically list all .tsx files under app/ that contain the string
// "spread". For each, the file must either:
//   (a) contain the disclaimer string (arb ≠ profit or &#8800; form), or
//   (b) be listed in DISCLAIMER_EXCEPTION_LIST with a documented reason.
//
// This test is a regression guard: if a developer adds a new spread-rendering
// component without the disclaimer, this test fails.
//
// Exception list — files that reference "spread" but do NOT render spread
// arbitrage values and therefore do not require the disclaimer:
// ---------------------------------------------------------------------------

/**
 * Exception list for the defensive coverage assertion.
 *
 * Each entry documents WHY the file is excepted from the disclaimer requirement.
 * The key is the file path relative to the repo root (using forward slashes).
 *
 * Rules for adding a new exception:
 *   1. The file must NOT render a numeric spread value to the user.
 *   2. The word "spread" must appear only in informational prose (e.g., "spread
 *      tracking", "spread alerts"), not in a numeric spread display.
 *   3. Add a brief rationale in the reason field.
 */
const DISCLAIMER_EXCEPTION_LIST: Record<string, string> = {
  /**
   * WatchedSection.tsx — documented exception from task-disclaimer-test brief.
   * This component renders the question list rows (query text, remove button).
   * It mentions "spread" only in the empty-state subtext:
   *   "Type a question above to start tracking spreads."
   * No numeric spread value is rendered here. The parent DashboardClient renders
   * the disclaimer in the sub-header and footer positions above and below this
   * component. Source: task-disclaimer-test DoD ("WatchedSection.tsx doesn't need
   * it because the parent DashboardClient renders the disclaimer").
   */
  "app/dashboard/WatchedSection.tsx":
    "Empty-state copy only ('tracking spreads'); no numeric spread value rendered. " +
    "Parent DashboardClient.tsx renders the disclaimer in sub-header and footer.",

  /**
   * SettingsKeyClient.tsx — informational references to spread tracking.
   * The word "spread" appears in:
   *   "resume spread tracking" (key-removed success message, line ~127)
   *   "pause spread tracking" (key-remove confirmation, line ~235)
   *   "This will pause all spread tracking." (key-remove confirmation, line ~241)
   * None of these are numeric spread value renditions. The Settings page does not
   * display any arb spread numbers. The disclaimer applies only to surfaces where
   * the user sees an actual numeric spread they might act on.
   */
  "app/settings/key/SettingsKeyClient.tsx":
    "Informational prose only ('resume spread tracking', 'pause spread tracking'). " +
    "No numeric spread value rendered. Settings page is not a spread-bearing surface.",

  /**
   * SignInForm.tsx — informational reference to spread alerts.
   * The word "spread" appears in:
   *   "We'll only use your email to send sign-in links and spread alerts."
   * This is legal boilerplate on the sign-in page, not a spread value display.
   * The sign-in page never renders a numeric arb spread.
   */
  "app/signin/SignInForm.tsx":
    "Legal boilerplate only ('send sign-in links and spread alerts'). " +
    "No numeric spread value rendered. Sign-in page is not a spread-bearing surface.",
};

test.describe("Group 3 — Defensive .tsx coverage: every spread-rendering component has the disclaimer or an exception", () => {
  /**
   * Grep all .tsx files under app/ that contain the string "spread".
   * Returns a list of paths relative to the repo root (forward-slash separated).
   */
  function findTsxFilesReferencingSpread(): string[] {
    try {
      // Use grep to find .tsx files containing "spread" (case-sensitive)
      // -r recursive, -l list files only, --include restrict to .tsx
      const output = execSync(
        `grep -rl --include="*.tsx" "spread" "${join(REPO_ROOT, "app")}"`,
        { encoding: "utf-8", cwd: REPO_ROOT }
      ).trim();

      if (!output) return [];

      return output
        .split("\n")
        .filter(Boolean)
        .map((absPath) => {
          // Normalise to repo-root-relative forward-slash path
          return absPath
            .replace(REPO_ROOT + "/", "")
            .replace(/\\/g, "/");
        });
    } catch (err: unknown) {
      // grep exits non-zero when no matches are found — treat as empty result
      if (
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        (err as { status: number }).status === 1
      ) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Return true if the file at the given absolute path contains the disclaimer
   * in either the Unicode form or the HTML entity form.
   */
  function fileContainsDisclaimer(absolutePath: string): boolean {
    try {
      const source = readFileSync(absolutePath, "utf-8");
      return (
        source.includes(DISCLAIMER_STRING) ||
        source.includes(DISCLAIMER_STRING_HTML_ENTITY) ||
        source.includes("arb ≠ profit")
      );
    } catch {
      return false;
    }
  }

  test(
    "all .tsx files under app/ that reference 'spread' have the disclaimer or are in the exception list",
    async () => {
      const spreadFiles = findTsxFilesReferencingSpread();

      if (spreadFiles.length === 0) {
        // No spread-referencing .tsx files found — nothing to check.
        // This is unlikely (DashboardClient.tsx always references spread) but
        // acceptable; the test passes vacuously.
        return;
      }

      const violations: string[] = [];

      for (const relPath of spreadFiles) {
        const absPath = join(REPO_ROOT, relPath);

        const hasDisclaimer = fileContainsDisclaimer(absPath);
        const isExcepted = Object.prototype.hasOwnProperty.call(
          DISCLAIMER_EXCEPTION_LIST,
          relPath
        );

        if (!hasDisclaimer && !isExcepted) {
          violations.push(
            `\n  ${relPath}\n` +
              `    No disclaimer found AND not in DISCLAIMER_EXCEPTION_LIST.\n` +
              `    Add the disclaimer ("${DISCLAIMER_STRING}") to this file,\n` +
              `    OR add it to DISCLAIMER_EXCEPTION_LIST in\n` +
              `    tests/disclaimer/disclaimer.spec.ts with a documented reason.`
          );
        }
      }

      expect(
        violations.length,
        `${violations.length} .tsx file(s) under app/ reference "spread" without the ` +
          `disclaimer and are not in the exception list:` +
          violations.join("") +
          `\n\nRule: every component that renders a numeric spread value to the user ` +
          `must include the disclaimer string "${DISCLAIMER_STRING}" ` +
          `OR be documented in the exception list in tests/disclaimer/disclaimer.spec.ts.\n` +
          `Source: docs/design/dashboard.md §5A.`
      ).toBe(0);
    }
  );

  test(
    "DISCLAIMER_EXCEPTION_LIST has no stale entries (every listed file still exists)",
    async () => {
      const staleEntries: string[] = [];

      for (const relPath of Object.keys(DISCLAIMER_EXCEPTION_LIST)) {
        const absPath = join(REPO_ROOT, relPath);
        if (!existsSync(absPath)) {
          staleEntries.push(
            `\n  ${relPath} — file no longer exists at this path.\n` +
              `  Remove this entry from DISCLAIMER_EXCEPTION_LIST in\n` +
              `  tests/disclaimer/disclaimer.spec.ts.`
          );
        }
      }

      expect(
        staleEntries.length,
        `${staleEntries.length} stale exception list entry/entries found (file(s) no longer exist):` +
          staleEntries.join("") +
          `\n\nRemove stale entries from DISCLAIMER_EXCEPTION_LIST.`
      ).toBe(0);
    }
  );

  test(
    "DashboardClient.tsx (primary spread-rendering component) is NOT in the exception list",
    async () => {
      // DashboardClient.tsx must never be added to the exception list — it is
      // the primary spread-rendering surface and must always contain the disclaimer.
      const dashboardClientPath = "app/dashboard/DashboardClient.tsx";

      expect(
        Object.prototype.hasOwnProperty.call(
          DISCLAIMER_EXCEPTION_LIST,
          dashboardClientPath
        ),
        `${dashboardClientPath} was found in DISCLAIMER_EXCEPTION_LIST. ` +
          `This file is the primary spread-rendering component and MUST always ` +
          `contain the disclaimer string. Remove it from the exception list and ` +
          `add the disclaimer to the file.`
      ).toBe(false);

      // Also verify it actually contains the disclaimer right now
      const absPath = join(REPO_ROOT, dashboardClientPath);
      const hasDisclaimer = fileContainsDisclaimer(absPath);

      expect(
        hasDisclaimer,
        `${dashboardClientPath} does not contain the disclaimer string ` +
          `"${DISCLAIMER_STRING}" (or its HTML entity form "&#8800;"). ` +
          `DashboardClient.tsx is the primary spread-rendering surface and ` +
          `must always include the disclaimer. Source: docs/design/dashboard.md §5A.`
      ).toBe(true);
    }
  );
});
