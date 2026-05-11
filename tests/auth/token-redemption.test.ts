/**
 * Test surface 2: Visiting a valid token URL creates an authenticated session.
 *
 * Stack: Vitest + Next.js test harness (server-level).
 * Mock boundary: Resend SDK — so we can capture the token URL from the email.
 *
 * Definition of Done assertion:
 *   (b) valid token creates an authenticated session.
 *
 * These tests MUST FAIL against the current repo (no auth implementation).
 * They will pass once task-auth-backend wires up NextAuth v5 with the
 * Drizzle adapter (database sessions) and task-auth-frontend builds the
 * /auth/verify route that NextAuth's Email Provider callback hits.
 *
 * Exact routes under test:
 *   GET  /api/auth/callback/email?token=<TOKEN>&email=<EMAIL>  (NextAuth internal)
 *   GET  /auth/verify?token=<TOKEN>                             (custom alias per UX spec)
 *   GET  /api/me                                               (auth-state endpoint)
 *   GET  /api/auth/session                                     (NextAuth session endpoint)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clearInbox,
  extractTokenUrls,
  getLatestEmail,
} from "./__mocks__/resend";
import {
  FIXTURE_USER,
  AUTH_ROUTES,
  SESSION_MAX_AGE_SECONDS,
} from "./helpers/fixture-user";

vi.mock("resend");

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requestMagicLink(email: string): Promise<void> {
  await fetch(`${BASE_URL}${AUTH_ROUTES.signinEmail}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email,
      csrfToken: "test-csrf-token",
      callbackUrl: `${BASE_URL}${AUTH_ROUTES.dashboard}`,
      json: "true",
    }),
    redirect: "manual",
  });
}

async function captureTokenFromInbox(email: string): Promise<string> {
  await requestMagicLink(email);
  const captured = getLatestEmail();
  const urls = extractTokenUrls(captured);

  if (urls.length === 0) {
    throw new Error(
      `No token URL found in the magic-link email for ${email}. ` +
        `magic-link-request.test.ts must pass before token-redemption.test.ts can run.`
    );
  }
  return urls[0];
}

async function redeemToken(
  tokenUrl: string,
  options: { followRedirects?: boolean } = {}
): Promise<Response> {
  return fetch(tokenUrl, {
    redirect: options.followRedirects ? "follow" : "manual",
  });
}

function parseSetCookieHeader(raw: string): Record<string, string> {
  const parts = raw.split(";").map((s) => s.trim());
  const attrs: Record<string, string> = {};
  for (const part of parts) {
    const [key, val] = part.split("=").map((s) => s.trim());
    attrs[key.toLowerCase()] = val ?? "true";
  }
  return attrs;
}

// ---------------------------------------------------------------------------

describe("Token redemption — valid token creates an authenticated session", () => {
  beforeEach(() => {
    clearInbox();
  });

  it("GET token URL returns a redirect (302/307) not a 404 or 500", async () => {
    const tokenUrl = await captureTokenFromInbox(FIXTURE_USER.email).catch(
      () => `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=not-implemented&email=${FIXTURE_USER.email}`
    );

    const res = await fetch(tokenUrl, { redirect: "manual" });

    expect(
      [302, 303, 307, 308].includes(res.status),
      `Expected a redirect from the token URL "${tokenUrl}" but got HTTP ${res.status}. ` +
        `The NextAuth Email Provider callback route (${AUTH_ROUTES.callbackEmail}) must be registered ` +
        `and the custom /auth/verify handler must redirect on success.`
    ).toBe(true);
  });

  it("successful token redemption sets a Set-Cookie header on the response", async () => {
    const tokenUrl = await captureTokenFromInbox(FIXTURE_USER.email).catch(
      () => `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=not-implemented&email=${FIXTURE_USER.email}`
    );

    const res = await redeemToken(tokenUrl);

    const cookies = res.headers.getSetCookie?.() ?? [];
    const rawCookieHeader = res.headers.get("set-cookie") ?? "";
    const hasCookie = cookies.length > 0 || rawCookieHeader.length > 0;

    expect(
      hasCookie,
      `Token redemption at "${tokenUrl}" did not set any cookies. ` +
        `ADR-0001 requires NextAuth database sessions with a session cookie ` +
        `(HttpOnly, Secure, SameSite=Lax, max-age = 30 days). ` +
        `Ensure the NextAuth Drizzle adapter is configured and ${AUTH_ROUTES.callbackEmail} ` +
        `returns a Set-Cookie header after validating the token.`
    ).toBe(true);
  });

  it("session cookie has the HttpOnly attribute", async () => {
    const tokenUrl = await captureTokenFromInbox(FIXTURE_USER.email).catch(
      () => `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=not-implemented&email=${FIXTURE_USER.email}`
    );

    const res = await redeemToken(tokenUrl);
    const rawCookie = res.headers.get("set-cookie") ?? "";

    expect(
      rawCookie.toLowerCase(),
      `Session cookie must have the HttpOnly attribute per ADR-0001 ` +
        `("cookie max-age = 30 days" + HttpOnly as mandated by auth-and-onboarding.md §2A step 10). ` +
        `Raw Set-Cookie header: "${rawCookie}"`
    ).toContain("httponly");
  });

  it("session cookie has the SameSite=Lax attribute", async () => {
    const tokenUrl = await captureTokenFromInbox(FIXTURE_USER.email).catch(
      () => `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=not-implemented&email=${FIXTURE_USER.email}`
    );

    const res = await redeemToken(tokenUrl);
    const rawCookie = res.headers.get("set-cookie") ?? "";

    expect(
      rawCookie.toLowerCase(),
      `Session cookie must have SameSite=Lax per auth-and-onboarding.md §2A step 10. ` +
        `Raw Set-Cookie header: "${rawCookie}"`
    ).toContain("samesite=lax");
  });

  it("session cookie Max-Age is at least 30 days (2592000 seconds)", async () => {
    const tokenUrl = await captureTokenFromInbox(FIXTURE_USER.email).catch(
      () => `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=not-implemented&email=${FIXTURE_USER.email}`
    );

    const res = await redeemToken(tokenUrl);
    const rawCookie = res.headers.get("set-cookie") ?? "";
    const attrs = parseSetCookieHeader(rawCookie);
    const maxAge = parseInt(attrs["max-age"] ?? "0", 10);

    expect(
      maxAge,
      `Session cookie Max-Age must be at least ${SESSION_MAX_AGE_SECONDS} seconds (30 days) ` +
        `per ADR-0001 "cookie max-age = 30 days". ` +
        `Got Max-Age=${maxAge}. Raw Set-Cookie: "${rawCookie}"`
    ).toBeGreaterThanOrEqual(SESSION_MAX_AGE_SECONDS);
  });

  it("authenticated request to /api/me returns the signed-in user's email", async () => {
    const tokenUrl = await captureTokenFromInbox(FIXTURE_USER.email).catch(
      () => `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=not-implemented&email=${FIXTURE_USER.email}`
    );

    // Redeem the token and capture the session cookie
    const redeemRes = await redeemToken(tokenUrl);
    const sessionCookie = redeemRes.headers.get("set-cookie") ?? "";

    if (!sessionCookie) {
      // If no cookie was set, the test cannot proceed — still fail with a clear message
      expect(
        sessionCookie,
        `Cannot test /api/me because token redemption did not set a session cookie. ` +
          `Fix the session-cookie test first.`
      ).toBeTruthy();
      return;
    }

    // Extract just the name=value portion for the Cookie request header
    const cookieValue = sessionCookie.split(";")[0];

    const meRes = await fetch(`${BASE_URL}${AUTH_ROUTES.me}`, {
      headers: { Cookie: cookieValue },
    });

    expect(
      meRes.ok,
      `GET ${AUTH_ROUTES.me} returned HTTP ${meRes.status} when called with a valid session cookie. ` +
        `The /api/me route must exist and return 200 for authenticated requests. ` +
        `Cookie sent: "${cookieValue}"`
    ).toBe(true);

    const body = await meRes.json().catch(() => ({}));

    expect(
      body?.email ?? body?.user?.email,
      `GET ${AUTH_ROUTES.me} did not return an email field in the response body. ` +
        `Expected: { email: "${FIXTURE_USER.email}" } (or nested under .user.email). ` +
        `Got: ${JSON.stringify(body)}`
    ).toBe(FIXTURE_USER.email);
  });

  it("unauthenticated request to /api/me returns 401", async () => {
    const res = await fetch(`${BASE_URL}${AUTH_ROUTES.me}`);

    expect(
      res.status,
      `GET ${AUTH_ROUTES.me} without a session cookie must return 401. ` +
        `Got ${res.status}. The auth middleware must protect this route.`
    ).toBe(401);
  });
});
