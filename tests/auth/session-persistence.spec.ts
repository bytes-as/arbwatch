/**
 * Test surface 5: Session cookie persists across simulated browser restart.
 *
 * Stack: Playwright (browser-level) — cookie behavior, max-age, cross-client persistence.
 *
 * Definition of Done assertion:
 *   (e) session cookie persists across simulated browser restart.
 *
 * These tests MUST FAIL against the current repo (no auth implementation).
 * They will pass once task-auth-backend configures NextAuth v5 database sessions
 * with max-age=30 days, and task-auth-frontend builds the /auth/verify flow.
 *
 * "Browser restart" simulation approach:
 *   1. Open a browser context, sign in, capture the session cookie.
 *   2. Close that context (discarding all in-memory state).
 *   3. Open a NEW browser context with no cookies.
 *   4. Manually inject only the captured session cookie value.
 *   5. Assert the authenticated endpoint returns the user identity.
 *
 * This mirrors what happens when a user closes their laptop and reopens
 * it 6 hours later — the cookie persists in the browser's cookie jar
 * because Max-Age is 30 days, and the server session record is still valid.
 *
 * Routes under test:
 *   GET  /signin                  — start the sign-in flow
 *   GET  /auth/verify?token=...   — complete the flow (or NextAuth callback)
 *   GET  /api/me                  — auth-state probe (must return identity)
 *   GET  /api/auth/session        — NextAuth session endpoint (returns JSON)
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  FIXTURE_USER,
  AUTH_ROUTES,
  SESSION_MAX_AGE_SECONDS,
} from "./helpers/fixture-user";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

/**
 * Complete the sign-in flow for a given email via the UI and return
 * the session cookie captured from the browser context.
 *
 * In a real test run, the Resend mock will capture the magic-link URL
 * and this helper reads it from the mock inbox. Until the auth backend
 * is implemented, this helper will throw — which is the expected
 * "test fails because implementation is missing" behaviour.
 */
async function signInAndCaptureCookie(
  context: BrowserContext,
  email: string
): Promise<{ cookieName: string; cookieValue: string; expires: number }> {
  const page = await context.newPage();

  // Navigate to the sign-in page
  await page.goto(`${BASE_URL}${AUTH_ROUTES.signin}`);

  // The sign-in page must render the form per auth-and-onboarding.md §3A
  await expect(
    page.locator('h1:has-text("Sign in to ArbWatch")'),
    `The sign-in page at ${AUTH_ROUTES.signin} must have an <h1> with text ` +
      `"Sign in to ArbWatch" per docs/design/auth-and-onboarding.md §5A.`
  ).toBeVisible();

  // Fill in the email and submit
  await page.fill('input[type="email"]', email);
  await page.click('button[type="submit"]:has-text("Send magic link")');

  // Page should navigate to /check-email
  await expect(page).toHaveURL(new RegExp(AUTH_ROUTES.checkEmail), {
    timeout: 10_000,
  });

  // At this point in a real run, the Resend mock inbox holds the token URL.
  // We fetch it via the test-only endpoint that exposes the mock inbox.
  // If this endpoint does not exist, the test fails here — which is correct.
  const inboxRes = await page.request.get(
    `${BASE_URL}/__test/mock-inbox/latest`
  );
  expect(
    inboxRes.ok(),
    `The test-only endpoint /__test/mock-inbox/latest must return the latest captured email. ` +
      `Got HTTP ${inboxRes.status()}. ` +
      `The backend must expose this endpoint only when NODE_ENV=test, ` +
      `so Playwright can retrieve the magic-link URL without accessing the file system.`
  ).toBeTruthy();

  const inboxBody = await inboxRes.json();
  const tokenUrl: string =
    inboxBody?.tokenUrl ?? inboxBody?.url ?? inboxBody?.magicLinkUrl ?? "";

  expect(
    tokenUrl,
    `/__test/mock-inbox/latest must return a tokenUrl field containing the magic-link URL. ` +
      `Got: ${JSON.stringify(inboxBody)}`
  ).toBeTruthy();

  // Navigate to the token URL to complete the sign-in
  await page.goto(tokenUrl);

  // Should redirect to /onboarding/key (no key) or /dashboard (key present)
  await expect(page).toHaveURL(
    new RegExp(`${AUTH_ROUTES.dashboard}|${AUTH_ROUTES.onboardingKey}`),
    { timeout: 10_000 }
  );

  // Capture the session cookie from the browser context
  const cookies = await context.cookies();
  const sessionCookie = cookies.find(
    (c) =>
      c.name.toLowerCase().includes("next-auth") ||
      c.name.toLowerCase().includes("session") ||
      c.name.startsWith("__Secure") ||
      c.name.startsWith("__Host")
  );

  expect(
    sessionCookie,
    `No session cookie found after completing sign-in. ` +
      `Cookies present: [${cookies.map((c) => c.name).join(", ")}]. ` +
      `ADR-0001 requires NextAuth to set a database session cookie with max-age=30 days.`
  ).toBeDefined();

  await page.close();

  return {
    cookieName: sessionCookie!.name,
    cookieValue: sessionCookie!.value,
    expires: sessionCookie!.expires,
  };
}

// ---------------------------------------------------------------------------

test.describe("Session persistence across simulated browser restart", () => {
  test(
    "session cookie Max-Age / Expires encodes at least 30 days from now",
    async ({ browser }) => {
      const context = await browser.newContext();

      try {
        const { expires } = await signInAndCaptureCookie(
          context,
          FIXTURE_USER.email
        );

        const nowSeconds = Math.floor(Date.now() / 1000);
        const remainingSeconds = expires - nowSeconds;

        expect(
          remainingSeconds,
          `Session cookie Expires must be at least ${SESSION_MAX_AGE_SECONDS} seconds (30 days) ` +
            `from now, per ADR-0001 "cookie max-age = 30 days". ` +
            `Got ${remainingSeconds} seconds remaining (expires at Unix ${expires}, now is ${nowSeconds}).`
        ).toBeGreaterThanOrEqual(SESSION_MAX_AGE_SECONDS - 60); // 60s tolerance for test execution time
      } finally {
        await context.close();
      }
    }
  );

  test(
    "authenticated endpoint returns user identity when cookie is replayed in a fresh context",
    async ({ browser }) => {
      // Step 1: Sign in in context A, capture the session cookie
      const contextA = await browser.newContext();
      let capturedCookie: { cookieName: string; cookieValue: string; expires: number };

      try {
        capturedCookie = await signInAndCaptureCookie(
          contextA,
          FIXTURE_USER.email
        );
      } finally {
        await contextA.close(); // Discard all in-memory browser state
      }

      // Step 2: Open a fresh context with no prior cookies
      const contextB = await browser.newContext();

      try {
        // Inject only the captured session cookie value
        await contextB.addCookies([
          {
            name: capturedCookie.cookieName,
            value: capturedCookie.cookieValue,
            domain: new URL(BASE_URL).hostname,
            path: "/",
            httpOnly: true,
            secure: BASE_URL.startsWith("https"),
            sameSite: "Lax",
            expires: capturedCookie.expires,
          },
        ]);

        const pageB = await contextB.newPage();

        // Step 3: The authenticated endpoint must still recognise the session
        const meRes = await pageB.request.get(`${BASE_URL}${AUTH_ROUTES.me}`);

        expect(
          meRes.ok(),
          `GET ${AUTH_ROUTES.me} returned HTTP ${meRes.status()} when called with the ` +
            `replayed session cookie from a fresh browser context. ` +
            `This simulates a browser restart (context A closed, context B opened). ` +
            `ADR-0001 uses database sessions (not JWT), so the session must remain valid ` +
            `as long as the server-side session record exists and the cookie has not expired.`
        ).toBeTruthy();

        const body = await meRes.json().catch(() => ({}));
        const returnedEmail = body?.email ?? body?.user?.email;

        expect(
          returnedEmail,
          `After browser restart simulation, /api/me must return the signed-in user's email. ` +
            `Expected "${FIXTURE_USER.email}" but got "${returnedEmail}". ` +
            `Full response body: ${JSON.stringify(body)}`
        ).toBe(FIXTURE_USER.email);

        await pageB.close();
      } finally {
        await contextB.close();
      }
    }
  );

  test(
    "session cookie has HttpOnly and SameSite=Lax set in the browser cookie jar",
    async ({ browser }) => {
      const context = await browser.newContext();

      try {
        await signInAndCaptureCookie(context, FIXTURE_USER.email);

        const cookies = await context.cookies();
        const sessionCookie = cookies.find(
          (c) =>
            c.name.toLowerCase().includes("next-auth") ||
            c.name.toLowerCase().includes("session")
        );

        expect(
          sessionCookie,
          "Session cookie must be present in the browser cookie jar after sign-in."
        ).toBeDefined();

        expect(
          sessionCookie!.httpOnly,
          `Session cookie "${sessionCookie!.name}" must have HttpOnly=true ` +
            `per auth-and-onboarding.md §2A step 10 and ADR-0001.`
        ).toBe(true);

        expect(
          sessionCookie!.sameSite,
          `Session cookie "${sessionCookie!.name}" must have SameSite=Lax ` +
            `per auth-and-onboarding.md §2A step 10.`
        ).toBe("Lax");
      } finally {
        await context.close();
      }
    }
  );
});
