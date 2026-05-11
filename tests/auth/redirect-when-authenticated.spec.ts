/**
 * Test surface 6: Sign-in page redirects an already-authenticated visitor
 * to the dashboard.
 *
 * Stack: Playwright (browser-level) — needs a real browser to exercise the
 * middleware / client-side redirect that runs before paint.
 *
 * Definition of Done assertion:
 *   (f) signed-in user is redirected from sign-in to dashboard.
 *
 * These tests MUST FAIL against the current repo (no auth implementation).
 * They will pass once:
 *   - task-auth-backend: session middleware redirects authenticated requests
 *     away from /signin.
 *   - task-auth-frontend: the /signin page itself performs a client-side
 *     redirect to /dashboard when a session is detected (flow 2B in
 *     docs/design/auth-and-onboarding.md).
 *
 * UX spec reference: docs/design/auth-and-onboarding.md §2B
 *   "App detects active session → immediate client-side redirect to /dashboard.
 *    No sign-in UI is rendered; the redirect happens before paint."
 *
 * Routes under test:
 *   GET /signin    — must redirect to /dashboard when authenticated
 *   GET /         — root must redirect to /signin if not authed, /dashboard if authed
 */

import { test, expect, type BrowserContext } from "@playwright/test";
import { FIXTURE_USER, AUTH_ROUTES } from "./helpers/fixture-user";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject a plausible-looking (but actually invalid) session cookie into a
 * context. This lets us test the redirect behavior without a full sign-in
 * flow — the real sign-in flow is covered in session-persistence.spec.ts.
 *
 * For this specific test, we inject a well-formed fixture session token that
 * the seeded database must recognise. The skeleton seed must insert a session
 * row paired with the fixture user so this works without a live magic-link.
 */
async function injectFixtureSession(context: BrowserContext): Promise<void> {
  // The skeleton seed inserts a valid session for the fixture user.
  // The session token value must match what the seed writes to the
  // `sessions` table (Drizzle adapter's session.sessionToken column).
  const FIXTURE_SESSION_TOKEN =
    process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

  const domain = new URL(BASE_URL).hostname;

  await context.addCookies([
    {
      // NextAuth v5 database session cookie name pattern:
      // `next-auth.session-token` in dev, `__Secure-next-auth.session-token` in prod.
      // We set the dev variant; the backend must accept it.
      name: "next-auth.session-token",
      value: FIXTURE_SESSION_TOKEN,
      domain,
      path: "/",
      httpOnly: true,
      secure: false, // dev/test mode
      sameSite: "Lax",
    },
  ]);
}

// ---------------------------------------------------------------------------

test.describe("Redirect when already authenticated — /signin → /dashboard", () => {
  test(
    "GET /signin with a valid session cookie redirects to /dashboard before paint",
    async ({ browser }) => {
      const context = await browser.newContext();

      try {
        await injectFixtureSession(context);
        const page = await context.newPage();

        // Navigate to the sign-in page with a session already in the cookie jar
        await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`, {
          waitUntil: "commit", // capture the redirect as early as possible
        });

        // Wait for the final URL to settle
        await page.waitForURL(
          new RegExp(AUTH_ROUTES.dashboard),
          { timeout: 5_000 }
        );

        expect(
          page.url(),
          `GET ${AUTH_ROUTES.signin} with an authenticated session must redirect to ` +
            `${AUTH_ROUTES.dashboard} per docs/design/auth-and-onboarding.md §2B. ` +
            `Final URL was: "${page.url()}". ` +
            `The middleware (next.config.ts or middleware.ts) must detect the session ` +
            `cookie and redirect, OR the /signin page component must redirect client-side ` +
            `before any sign-in UI is rendered.`
        ).toContain(AUTH_ROUTES.dashboard);

        await page.close();
      } finally {
        await context.close();
      }
    }
  );

  test(
    "GET /signin with a valid session does NOT render the sign-in form",
    async ({ browser }) => {
      const context = await browser.newContext();

      try {
        await injectFixtureSession(context);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`);

        // After the redirect resolves, we must be on /dashboard — not /signin.
        // If the sign-in form is visible, the redirect did not fire.
        const isOnSignin = page.url().includes(AUTH_ROUTES.signin);

        if (isOnSignin) {
          const formVisible = await page
            .locator('button:has-text("Send magic link")')
            .isVisible()
            .catch(() => false);

          expect(
            formVisible,
            `The sign-in form ("Send magic link" button) must NOT be visible ` +
              `when the user already has a valid session. ` +
              `Current URL: "${page.url()}". ` +
              `docs/design/auth-and-onboarding.md §2B: ` +
              `"No sign-in UI is rendered; the redirect happens before paint."`
          ).toBe(false);
        }

        // Either we're on /dashboard, or the sign-in form is not rendered
        expect(
          page.url(),
          `Expected to be redirected to ${AUTH_ROUTES.dashboard} but still on "${page.url()}".`
        ).toContain(AUTH_ROUTES.dashboard);

        await page.close();
      } finally {
        await context.close();
      }
    }
  );

  test(
    "GET / (root) redirects an authenticated user to /dashboard",
    async ({ browser }) => {
      const context = await browser.newContext();

      try {
        await injectFixtureSession(context);
        const page = await context.newPage();

        await page.goto(`${BASE_URL}/`, { waitUntil: "commit" });

        // Root without auth redirects to /signin; root with auth to /dashboard.
        // Either the middleware does this, or the root page handles it.
        await page.waitForURL(
          new RegExp(`${AUTH_ROUTES.dashboard}|${AUTH_ROUTES.signin}`),
          { timeout: 5_000 }
        );

        // Must NOT end up on /signin — we're authenticated.
        expect(
          page.url().includes(AUTH_ROUTES.signin),
          `GET / with an authenticated session must redirect to ${AUTH_ROUTES.dashboard}, ` +
            `not to ${AUTH_ROUTES.signin}. Final URL: "${page.url()}". ` +
            `docs/design/auth-and-onboarding.md §2A step 2: ` +
            `"App detects no session → redirects to /signin." ` +
            `Converse: app detects a session → must NOT redirect to /signin.`
        ).toBe(false);

        expect(
          page.url(),
          `GET / with an authenticated session must ultimately reach ${AUTH_ROUTES.dashboard}.`
        ).toContain(AUTH_ROUTES.dashboard);

        await page.close();
      } finally {
        await context.close();
      }
    }
  );

  test(
    "GET /signin WITHOUT a session cookie renders the sign-in form (control test)",
    async ({ browser }) => {
      // This is the "control" — verify that WITHOUT a session, the sign-in page renders normally.
      // If this test also fails, the sign-in page itself is broken, not just the redirect logic.
      const context = await browser.newContext(); // no injected session

      try {
        const page = await context.newPage();
        await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`);

        await expect(
          page.locator('button:has-text("Send magic link")'),
          `GET ${AUTH_ROUTES.signin} without a session must render the "Send magic link" button ` +
            `per docs/design/auth-and-onboarding.md §5A. ` +
            `If this fails, the sign-in page itself is not implemented yet — ` +
            `task-auth-frontend must build this page.`
        ).toBeVisible({ timeout: 5_000 });

        await page.close();
      } finally {
        await context.close();
      }
    }
  );

  test(
    "the sign-in page title is 'Sign in — ArbWatch' per UX spec",
    async ({ page }) => {
      await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`);

      await expect(
        page,
        `docs/design/auth-and-onboarding.md §5A specifies the page <title> as ` +
          `"Sign in — ArbWatch". The frontend implementation must set this title.`
      ).toHaveTitle("Sign in — ArbWatch");
    }
  );

  test(
    "the sign-in page h1 is 'Sign in to ArbWatch' per UX spec",
    async ({ page }) => {
      await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`);

      await expect(
        page.locator("h1"),
        `docs/design/auth-and-onboarding.md §5A specifies the <h1> as ` +
          `"Sign in to ArbWatch". The frontend implementation must render this heading.`
      ).toContainText("Sign in to ArbWatch");
    }
  );

  test(
    "the submit button label is 'Send magic link' per UX spec",
    async ({ page }) => {
      await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`);

      await expect(
        page.locator('button[type="submit"]'),
        `docs/design/auth-and-onboarding.md §5A specifies the submit button label as ` +
          `"Send magic link". The frontend implementation must use this exact text.`
      ).toContainText("Send magic link");
    }
  );
});
