/**
 * tests/key/onboarding-flow.spec.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-key-frontend implements /onboarding/key page
 *   - task-key-frontend implements key paste → save flow
 *   - task-key-frontend implements /settings/key page (rotation + removal)
 *   - Middleware redirects key-missing users from /dashboard to /onboarding/key
 *   - Middleware allows users with a key to access /dashboard
 *
 * Test surfaces covered (per task-key-test brief §Frontend):
 *   9.  Onboarding blocks dashboard: key-missing user → /onboarding/key, not /dashboard.
 *   10. Paste, accept, advance: valid key → save → /dashboard → empty state renders.
 *   11. Invalid-format inline error: invalid key → inline error, no navigation.
 *   12. Settings rotation: rotate key from /settings/key → dashboard accessible → success.
 *   13. Settings removal: remove key from /settings/key → /dashboard inaccessible → banner.
 *
 * UX spec copy sources (all assertions are locked to these strings):
 *   - docs/design/auth-and-onboarding.md §5C — onboarding page copy and inline errors
 *   - docs/design/dashboard.md §5F         — banner copy (supersedes onboarding §5D)
 *   - docs/design/dashboard.md §5C         — empty state copy
 *   - docs/design/auth-and-onboarding.md §5E — welcome toast copy
 *
 * Stack: Playwright (browser-level). Uses the same session-cookie injection
 *        pattern as tests/auth/redirect-when-authenticated.spec.ts.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  FIXTURE_USER_WITH_KEY,
  FIXTURE_USER_NO_KEY,
  VALID_FORMAT_KEY,
  VALID_FORMAT_KEY_2,
  INVALID_KEYS,
  ONBOARDING_COPY,
  DASHBOARD_BANNER_COPY,
  DASHBOARD_EMPTY_STATE_COPY,
  WELCOME_TOAST_COPY,
} from "./helpers/fixture-key";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

/** Session token for user A (has a key; status = ok). */
const SESSION_A =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

/** Session token for user B (no key; status = key-missing). */
const SESSION_B =
  process.env.FIXTURE_SESSION_TOKEN_B ?? "fixture-session-token-b-do-not-use-in-prod";

const ROUTES = {
  dashboard: "/dashboard",
  onboardingKey: "/onboarding/key",
  settingsKey: "/settings/key",
  signin: "/signin",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function injectSession(context: BrowserContext, token: string): Promise<void> {
  const domain = new URL(BASE_URL).hostname;
  await context.addCookies([
    {
      name: "next-auth.session-token",
      value: token,
      domain,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

// ---------------------------------------------------------------------------
// Test 9: Onboarding blocks dashboard (key-missing user)
// ---------------------------------------------------------------------------

test.describe("Test 9 — Onboarding gate: key-missing user cannot access /dashboard", () => {
  test(
    "GET /dashboard as user B (key-missing) redirects to /onboarding/key, not dashboard",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.dashboard}`, {
          waitUntil: "commit",
        });

        await page.waitForURL(
          new RegExp(`${ROUTES.onboardingKey}|${ROUTES.signin}`),
          { timeout: 5_000 }
        ).catch(() => {/* let the assertion below catch it */});

        expect(
          page.url().includes(ROUTES.dashboard),
          `A user with anakin_key_status="key-missing" must NOT be allowed to access ` +
            `${ROUTES.dashboard}. Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §2A step 11: ` +
            `"No key → redirect to /onboarding/key". ` +
            `The middleware must check anakin_key_status and redirect key-missing users.`
        ).toBe(false);

        expect(
          page.url().includes(ROUTES.onboardingKey) || page.url().includes(ROUTES.signin),
          `User with key-missing landed on "${page.url()}" instead of ${ROUTES.onboardingKey}. ` +
            `The middleware must redirect to the key onboarding page.`
        ).toBe(true);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "GET /dashboard as user B renders /onboarding/key page heading",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.dashboard}`);
        await page.waitForURL(new RegExp(ROUTES.onboardingKey), { timeout: 5_000 }).catch(() => {});

        await expect(
          page.locator("h1"),
          `The onboarding key page <h1> must be "${ONBOARDING_COPY.heading}". ` +
            `docs/design/auth-and-onboarding.md §5C.`
        ).toContainText(ONBOARDING_COPY.heading, { timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "GET /dashboard as user A (status=ok) reaches /dashboard without redirect",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_A);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.dashboard}`, {
          waitUntil: "commit",
        });
        await page.waitForURL(new RegExp(ROUTES.dashboard), { timeout: 5_000 }).catch(() => {});

        expect(
          page.url().includes(ROUTES.dashboard),
          `User A (status=ok) should access ${ROUTES.dashboard} directly. ` +
            `Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §2A step 11: ` +
            `"Key present → redirect to /dashboard".`
        ).toBe(true);

        // Must NOT be redirected to onboarding
        expect(
          page.url().includes(ROUTES.onboardingKey),
          `User A (status=ok) was incorrectly redirected to ${ROUTES.onboardingKey}.`
        ).toBe(false);
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 10: Paste valid key, accept, advance to dashboard
// ---------------------------------------------------------------------------

test.describe("Test 10 — Valid key paste: advance to /dashboard", () => {
  test(
    "Page title is spec'd value on /onboarding/key",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);

        await expect(
          page,
          `docs/design/auth-and-onboarding.md §5C: ` +
            `page <title> must be "Connect your Anakin key — ArbWatch".`
        ).toHaveTitle("Connect your Anakin key — ArbWatch", { timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Onboarding key page renders all required UX-spec'd elements",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);

        // h1
        await expect(
          page.locator("h1"),
          `docs/design/auth-and-onboarding.md §5C: <h1> must be "${ONBOARDING_COPY.heading}".`
        ).toContainText(ONBOARDING_COPY.heading, { timeout: 5_000 });

        // Key input
        await expect(
          page.locator("#anakin-key"),
          `docs/design/auth-and-onboarding.md §3C: key input must have id="anakin-key".`
        ).toBeVisible();

        // Submit button
        await expect(
          page.locator(`button:has-text("${ONBOARDING_COPY.submitButton}")`),
          `docs/design/auth-and-onboarding.md §5C: submit button must say "${ONBOARDING_COPY.submitButton}".`
        ).toBeVisible();

        // Show/hide toggle
        await expect(
          page.locator(`button:has-text("${ONBOARDING_COPY.showKey}")`),
          `docs/design/auth-and-onboarding.md §5C: show/hide toggle must say "${ONBOARDING_COPY.showKey}" initially.`
        ).toBeVisible();

        // Security note text
        await expect(
          page.locator("text=encrypted before it is stored"),
          `docs/design/auth-and-onboarding.md §3C: security note must be present.`
        ).toBeVisible();
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Typing and saving a valid-format key advances to /dashboard",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });

        // Type a valid key
        await page.fill("#anakin-key", VALID_FORMAT_KEY);

        // Submit
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);

        // Should navigate to /dashboard
        await page.waitForURL(new RegExp(ROUTES.dashboard), { timeout: 10_000 });

        expect(
          page.url().includes(ROUTES.dashboard),
          `After saving a valid key, the user must be redirected to ${ROUTES.dashboard}. ` +
            `Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §2A step 14: ` +
            `"Probe succeeds → key stored encrypted at rest → redirect to /dashboard with welcome toast."`
        ).toBe(true);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Dashboard shows empty-state copy after first key save",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        // Go through onboarding
        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });
        await page.fill("#anakin-key", VALID_FORMAT_KEY);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);
        await page.waitForURL(new RegExp(ROUTES.dashboard), { timeout: 10_000 });

        // Empty state must be visible
        await expect(
          page.locator(`text=${DASHBOARD_EMPTY_STATE_COPY.heading}`),
          `docs/design/dashboard.md §5C: empty-state heading must be ` +
            `"${DASHBOARD_EMPTY_STATE_COPY.heading}".`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Welcome toast appears on /dashboard after first key save",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });
        await page.fill("#anakin-key", VALID_FORMAT_KEY);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);
        await page.waitForURL(new RegExp(ROUTES.dashboard), { timeout: 10_000 });

        await expect(
          page.locator(`text=${WELCOME_TOAST_COPY}`),
          `docs/design/auth-and-onboarding.md §5E: welcome toast must say ` +
            `"${WELCOME_TOAST_COPY}" after the first key save.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 11: Invalid-format inline error
// ---------------------------------------------------------------------------

test.describe("Test 11 — Invalid key paste: inline error, no navigation", () => {
  test(
    "Submitting an empty key shows the format-invalid inline error",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });

        // Leave the field empty and try to submit
        await page.fill("#anakin-key", INVALID_KEYS.empty);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);

        // The inline error must appear
        await expect(
          page.locator('[role="alert"]').filter({ hasText: "valid Anakin API key" }),
          `docs/design/auth-and-onboarding.md §5C: format-invalid error must say ` +
            `"${ONBOARDING_COPY.errors.formatInvalid}" (or contain "valid Anakin API key"). ` +
            `The error must appear in role="alert" per §3C component hierarchy.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Submitting a too-short key shows the format-invalid inline error",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });

        await page.fill("#anakin-key", INVALID_KEYS.tooShort);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);

        await expect(
          page.locator('[role="alert"]').filter({ hasText: "valid Anakin API key" }),
          `Submitting a ${INVALID_KEYS.tooShort.length}-char key must trigger the format-invalid error. ` +
            `docs/design/auth-and-onboarding.md §5C.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Invalid-format submission stays on /onboarding/key (no navigation)",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });

        await page.fill("#anakin-key", INVALID_KEYS.tooShort);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);

        // Wait briefly to confirm no navigation happened
        await page.waitForTimeout(1_500);

        expect(
          page.url().includes(ROUTES.onboardingKey),
          `An invalid-format key submission must NOT navigate away from ${ROUTES.onboardingKey}. ` +
            `Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §4C: format-invalid → inline error, no server call.`
        ).toBe(true);

        expect(
          page.url().includes(ROUTES.dashboard),
          `An invalid-format key submission must NOT reach /dashboard. ` +
            `Final URL: "${page.url()}".`
        ).toBe(false);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Inline error has role=alert and references the key input via aria-describedby",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.onboardingKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });

        await page.fill("#anakin-key", INVALID_KEYS.tooShort);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);
        await page.waitForSelector('[role="alert"]', { timeout: 5_000 });

        // The inline error must have role=alert (per §3C component hierarchy)
        const errorEl = page.locator('[role="alert"]').first();
        await expect(errorEl).toBeVisible();

        // The key input must reference the error via aria-describedby
        // (per docs/design/auth-and-onboarding.md §6C ARIA notes)
        const describedBy = await page
          .locator("#anakin-key")
          .getAttribute("aria-describedby");
        expect(
          describedBy,
          `The key input must have aria-describedby referencing the error element. ` +
            `docs/design/auth-and-onboarding.md §6C: ` +
            `aria-describedby="key-security-note key-error"`
        ).toBeTruthy();
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 12: Settings rotation
// ---------------------------------------------------------------------------

test.describe("Test 12 — Settings key rotation", () => {
  test(
    "GET /settings/key renders the key input form",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_A);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.settingsKey}`);

        // The settings key page must show the same key input form as onboarding
        await expect(
          page.locator("#anakin-key"),
          `${ROUTES.settingsKey} must render a key input with id="anakin-key". ` +
            `docs/design/dashboard.md §9: "The Settings page presents the same key-input ` +
            `form as /onboarding/key."`
        ).toBeVisible({ timeout: 5_000 });

        await expect(
          page.locator(`button:has-text("${ONBOARDING_COPY.submitButton}")`),
          `${ROUTES.settingsKey} must render a "${ONBOARDING_COPY.submitButton}" button.`
        ).toBeVisible();
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Rotating key from /settings/key: dashboard remains accessible afterwards",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_A);
        const page = await context.newPage();

        // Navigate to settings and rotate the key
        await page.goto(`${BASE_URL}${ROUTES.settingsKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });
        await page.fill("#anakin-key", VALID_FORMAT_KEY_2);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);

        // After rotation, either stay on settings (non-blocking per §9) or navigate to dashboard
        await page.waitForTimeout(2_000);

        // Dashboard must still be accessible
        await page.goto(`${BASE_URL}${ROUTES.dashboard}`);
        await page.waitForURL(new RegExp(ROUTES.dashboard), { timeout: 5_000 });

        expect(
          page.url().includes(ROUTES.dashboard),
          `After key rotation, the user must still be able to access ${ROUTES.dashboard}. ` +
            `Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §2H and flow 2H: after a valid key save, ` +
            `the dashboard remains accessible.`
        ).toBe(true);

        // Must NOT be redirected to onboarding after rotation
        expect(
          page.url().includes(ROUTES.onboardingKey),
          `After key rotation, the user was incorrectly sent to ${ROUTES.onboardingKey}. ` +
            `Key rotation must update the stored key and keep the user in the authenticated flow.`
        ).toBe(false);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Rotation success affordance (success indicator) appears after saving new key",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_A);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.settingsKey}`);
        await page.waitForSelector("#anakin-key", { timeout: 5_000 });
        await page.fill("#anakin-key", VALID_FORMAT_KEY_2);
        await page.click(`button:has-text("${ONBOARDING_COPY.submitButton}")`);

        // A success affordance must appear: either a toast, a success message, or
        // the welcome-toast copy (if the settings page reuses the onboarding toast).
        const successLocator = page
          .locator(
            '[role="status"], [role="alert"], .toast, [data-testid="success"]'
          )
          .filter({
            hasText: /saved|updated|success|key.*rotated|You're all set/i,
          });

        await expect(
          successLocator,
          `After key rotation on ${ROUTES.settingsKey}, a success affordance must appear. ` +
            `The UX spec does not prescribe the exact copy for settings rotation (see §9 placeholder), ` +
            `but a visible success indicator is required so the user knows the rotation succeeded.`
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await context.close();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 13: Settings removal
// ---------------------------------------------------------------------------

test.describe("Test 13 — Settings key removal", () => {
  test(
    "/settings/key has a Remove key affordance",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_A);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.settingsKey}`);

        // The settings page must have some removal affordance
        const removeButton = page.locator(
          'button:has-text("Remove"), button:has-text("Delete"), button:has-text("remove key"), button:has-text("delete key")'
        );

        await expect(
          removeButton,
          `${ROUTES.settingsKey} must have a "Remove key" or "Delete" button. ` +
            `docs/design/auth-and-onboarding.md §2H: the user can remove their key from settings.`
        ).toBeVisible({ timeout: 5_000 });
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Removing key from /settings/key: subsequent /dashboard attempt redirects to onboarding",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        await injectSession(context, SESSION_A);
        const page = await context.newPage();

        // Go to settings and remove the key
        await page.goto(`${BASE_URL}${ROUTES.settingsKey}`);
        await page.waitForSelector(
          'button:has-text("Remove"), button:has-text("Delete"), button:has-text("remove key")',
          { timeout: 5_000 }
        );

        const removeButton = page.locator(
          'button:has-text("Remove"), button:has-text("Delete"), button:has-text("remove key")'
        ).first();
        await removeButton.click();

        // May require a confirmation
        const confirmButton = page.locator(
          'button:has-text("Yes"), button:has-text("Confirm"), button:has-text("Yes, remove")'
        );
        if (await confirmButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await confirmButton.click();
        }

        await page.waitForTimeout(1_500);

        // Now attempt to visit /dashboard
        await page.goto(`${BASE_URL}${ROUTES.dashboard}`, { waitUntil: "commit" });
        await page.waitForURL(
          new RegExp(`${ROUTES.onboardingKey}|${ROUTES.signin}`),
          { timeout: 5_000 }
        ).catch(() => {});

        expect(
          page.url().includes(ROUTES.dashboard),
          `After removing the key, accessing ${ROUTES.dashboard} must redirect to ` +
            `${ROUTES.onboardingKey} (or ${ROUTES.signin}). ` +
            `Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §2A step 11: no key → redirect to /onboarding/key.`
        ).toBe(false);
      } finally {
        await context.close();
      }
    }
  );

  test(
    "After removal, bypassing onboarding directly to /dashboard shows key-missing banner",
    async ({ browser }) => {
      // This test simulates the scenario where the user bypasses the onboarding
      // redirect somehow (e.g. direct URL) and the dashboard renders a key-missing banner.
      // This is the "defensive" state described in dashboard.md §State 6A.
      const context = await browser.newContext();
      try {
        // Use SESSION_B which starts with key-missing from the seed
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        // Force direct navigation to /dashboard as a user without a key
        // (The middleware may redirect, but if somehow the dashboard renders, assert the banner)
        await page.goto(`${BASE_URL}${ROUTES.dashboard}`);

        // Wait to see where we land
        await page.waitForTimeout(2_000);

        if (page.url().includes(ROUTES.dashboard)) {
          // If we reached the dashboard (middleware did not redirect), the banner must appear
          await expect(
            page.locator(`text=${DASHBOARD_BANNER_COPY.heading}`),
            `If the dashboard renders for a key-missing user, the ` +
              `"${DASHBOARD_BANNER_COPY.heading}" banner must appear. ` +
              `docs/design/dashboard.md §5F (key-missing) and §State 6A.`
          ).toBeVisible({ timeout: 5_000 });

          await expect(
            page.locator(`text=${DASHBOARD_BANNER_COPY.keyMissing}`),
            `The key-missing banner body must say "${DASHBOARD_BANNER_COPY.keyMissing}". ` +
              `docs/design/dashboard.md §5F.`
          ).toBeVisible({ timeout: 5_000 });
        } else {
          // Middleware correctly redirected to onboarding — pass
          expect(
            page.url().includes(ROUTES.onboardingKey) || page.url().includes(ROUTES.signin),
            `After removal, the user was redirected to "${page.url()}", which is neither ` +
              `${ROUTES.onboardingKey} nor ${ROUTES.signin}. ` +
              `The middleware must redirect to ${ROUTES.onboardingKey}.`
          ).toBe(true);
        }
      } finally {
        await context.close();
      }
    }
  );

  test(
    "Dashboard key-missing banner has 'Update key' CTA linking to /settings/key",
    async ({ browser }) => {
      const context = await browser.newContext();
      try {
        // Use SESSION_B (key-missing) to test the banner state
        await injectSession(context, SESSION_B);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${ROUTES.dashboard}`);
        await page.waitForTimeout(2_000);

        if (!page.url().includes(ROUTES.dashboard)) {
          // Middleware redirected — this test is not applicable since the user
          // never sees the dashboard. The test still passes because the
          // middleware is correctly blocking.
          test.skip();
          return;
        }

        // Banner CTA must be "Update key" linking to /settings/key
        const ctaLink = page.locator(
          `a:has-text("${DASHBOARD_BANNER_COPY.ctaText}")`
        );

        await expect(
          ctaLink,
          `The key-error banner must have a "${DASHBOARD_BANNER_COPY.ctaText}" link. ` +
            `docs/design/dashboard.md §5F: "Banner CTA link text: 'Update key'".`
        ).toBeVisible({ timeout: 5_000 });

        const href = await ctaLink.getAttribute("href");
        expect(
          href,
          `The "${DASHBOARD_BANNER_COPY.ctaText}" link must point to ${ROUTES.settingsKey}. ` +
            `Got href="${href}". ` +
            `docs/design/dashboard.md §5F: "Banner CTA link: 'Update key' → /settings/key".`
        ).toContain(ROUTES.settingsKey);
      } finally {
        await context.close();
      }
    }
  );
});
