/**
 * Test surfaces 3 & 4: Expired tokens are rejected. Already-used tokens are rejected.
 *
 * Stack: Vitest + Next.js test harness (server-level).
 * Clock manipulation: vi.useFakeTimers() to advance past the 15-minute TTL.
 *
 * Definition of Done assertions:
 *   (c) expired tokens rejected
 *   (d) already-used tokens rejected
 *
 * These tests MUST FAIL against the current repo (no auth implementation).
 * They will pass once task-auth-backend implements NextAuth v5 with the
 * Drizzle adapter storing per-token expiry and used-at timestamps.
 *
 * Routes under test:
 *   POST /api/auth/signin/email     — request the token
 *   GET  /api/auth/callback/email   — attempt to redeem (NextAuth internal)
 *   GET  /auth/verify               — custom verify alias (per UX spec)
 *   GET  /signin?error=expired      — expected error redirect destination
 *   GET  /signin?error=used         — expected error redirect destination
 *
 * Error copy locked to docs/design/auth-and-onboarding.md §5A:
 *   expired: "That sign-in link has expired. Enter your email below to get a new one."
 *   used:    "That sign-in link has already been used. Enter your email below to get a new one."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearInbox,
  extractTokenUrls,
  getLatestEmail,
} from "./__mocks__/resend";
import {
  FIXTURE_USER,
  FRESH_EMAIL,
  AUTH_ROUTES,
  TOKEN_TTL_MS,
  ERROR_COPY,
} from "./helpers/fixture-user";

vi.mock("resend");

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requestAndCaptureToken(email: string): Promise<string> {
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

  const email_ = getLatestEmail();
  const urls = extractTokenUrls(email_);
  if (urls.length === 0) {
    throw new Error(
      "No token URL in captured email — " +
        "magic-link-request.test.ts must pass before expired-replay.test.ts can run."
    );
  }
  return urls[0];
}

async function redeemToken(tokenUrl: string): Promise<Response> {
  return fetch(tokenUrl, { redirect: "manual" });
}

/**
 * Follow a redirect chain and return the final URL.
 * We need this to assert that expired/used tokens redirect to /signin?error=...
 */
async function finalRedirectUrl(tokenUrl: string): Promise<string> {
  const res = await fetch(tokenUrl, { redirect: "follow" });
  return res.url;
}

// ---------------------------------------------------------------------------
// EXPIRED TOKEN TESTS
// ---------------------------------------------------------------------------

describe("Expired token — rejection and UX-spec error routing", () => {
  beforeEach(() => {
    clearInbox();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expired token redirects to /signin?error=expired", async () => {
    // Capture the token before advancing the clock
    const tokenUrl = await requestAndCaptureToken(FIXTURE_USER.email);

    // Advance the clock past the 15-minute TTL defined in ADR-0001 / auth-and-onboarding.md §3B
    vi.useFakeTimers();
    vi.advanceTimersByTime(TOKEN_TTL_MS + 60_000); // TTL + 1 minute grace

    const finalUrl = await finalRedirectUrl(tokenUrl);
    const parsedUrl = new URL(finalUrl);

    expect(
      parsedUrl.pathname + parsedUrl.search,
      `Expired token must redirect to "${AUTH_ROUTES.signin}?error=expired" ` +
        `per docs/design/auth-and-onboarding.md §2D step 4. ` +
        `Got redirect to: "${finalUrl}". ` +
        `Token TTL is ${TOKEN_TTL_MS / 60_000} minutes (from auth-and-onboarding.md §3B).`
    ).toMatch(/\/signin\?.*error=expired/);
  });

  it("expired token does NOT set a session cookie", async () => {
    const tokenUrl = await requestAndCaptureToken(FIXTURE_USER.email);

    vi.useFakeTimers();
    vi.advanceTimersByTime(TOKEN_TTL_MS + 60_000);

    const res = await redeemToken(tokenUrl);
    const cookie = res.headers.get("set-cookie") ?? "";
    const hasSessionCookie =
      cookie.toLowerCase().includes("next-auth") ||
      cookie.toLowerCase().includes("session");

    expect(
      hasSessionCookie,
      `An expired token must NOT create a session. ` +
        `Got Set-Cookie: "${cookie}" — this indicates the token was accepted despite expiry. ` +
        `The NextAuth Drizzle adapter must reject tokens past their ${TOKEN_TTL_MS / 60_000}-minute TTL.`
    ).toBe(false);
  });

  it("the /signin page rendered after ?error=expired contains the UX-spec'd error copy", async () => {
    const errorPageUrl = `${BASE_URL}${AUTH_ROUTES.signin}?error=expired`;
    const res = await fetch(errorPageUrl);

    expect(
      res.ok,
      `GET ${errorPageUrl} returned HTTP ${res.status}. The sign-in page must exist.`
    ).toBe(true);

    const html = await res.text();
    expect(
      html,
      `The sign-in page at ${errorPageUrl} must contain the exact error banner copy ` +
        `from docs/design/auth-and-onboarding.md §5A "?error=expired": ` +
        `"${ERROR_COPY.expired}". ` +
        `The implementer must render a <div role="alert"> containing this exact string ` +
        `when ?error=expired is present in the URL.`
    ).toContain(ERROR_COPY.expired);
  });
});

// ---------------------------------------------------------------------------
// REPLAY (ALREADY-USED) TOKEN TESTS
// ---------------------------------------------------------------------------

describe("Already-used token — rejection and UX-spec error routing", () => {
  beforeEach(() => {
    clearInbox();
  });

  it("second redemption of a valid (non-expired) token redirects to /signin?error=used", async () => {
    // Use a unique email to avoid state pollution from other tests
    clearInbox();
    const tokenUrl = await requestAndCaptureToken(`replay-${Date.now()}@arbwatch.test`);

    // First redemption — should succeed
    const firstRes = await redeemToken(tokenUrl);
    expect(
      [200, 302, 303, 307, 308].includes(firstRes.status),
      `First token redemption returned HTTP ${firstRes.status}. ` +
        `Expected a success redirect. Check that the token URL is correct.`
    ).toBe(true);

    // Second redemption — must fail with error=used
    const finalUrl = await finalRedirectUrl(tokenUrl);
    const parsedUrl = new URL(finalUrl);

    expect(
      parsedUrl.pathname + parsedUrl.search,
      `Replay of an already-used token must redirect to "${AUTH_ROUTES.signin}?error=used" ` +
        `per docs/design/auth-and-onboarding.md §2E step 3b. ` +
        `Got: "${finalUrl}". ` +
        `The NextAuth Drizzle adapter must mark tokens as used after first redemption and ` +
        `reject subsequent attempts.`
    ).toMatch(/\/signin\?.*error=used/);
  });

  it("replayed token does NOT set a new session cookie", async () => {
    clearInbox();
    const tokenUrl = await requestAndCaptureToken(`noreplay-${Date.now()}@arbwatch.test`);

    // First use
    await redeemToken(tokenUrl);

    // Second use — capture cookies
    const replayRes = await redeemToken(tokenUrl);
    const cookie = replayRes.headers.get("set-cookie") ?? "";
    const hasNewSession =
      cookie.toLowerCase().includes("next-auth") ||
      cookie.toLowerCase().includes("session");

    expect(
      hasNewSession,
      `A replayed (already-used) token must NOT create a new session. ` +
        `Got Set-Cookie: "${cookie}". ` +
        `The NextAuth Drizzle adapter must check token.used_at before issuing a session.`
    ).toBe(false);
  });

  it("the /signin page rendered after ?error=used contains the UX-spec'd error copy", async () => {
    const errorPageUrl = `${BASE_URL}${AUTH_ROUTES.signin}?error=used`;
    const res = await fetch(errorPageUrl);

    expect(
      res.ok,
      `GET ${errorPageUrl} returned HTTP ${res.status}. The sign-in page must exist.`
    ).toBe(true);

    const html = await res.text();
    expect(
      html,
      `The sign-in page at ${errorPageUrl} must contain the exact error banner copy ` +
        `from docs/design/auth-and-onboarding.md §5A "?error=used": ` +
        `"${ERROR_COPY.used}". ` +
        `The implementer must render a <div role="alert"> containing this exact string ` +
        `when ?error=used is present in the URL.`
    ).toContain(ERROR_COPY.used);
  });

  it("error banner has role='alert' attribute in the rendered HTML", async () => {
    // Assert the accessibility requirement from docs/design/auth-and-onboarding.md §3A:
    // Error banner uses <div role="alert">
    for (const errorParam of ["expired", "used"] as const) {
      const errorPageUrl = `${BASE_URL}${AUTH_ROUTES.signin}?error=${errorParam}`;
      const res = await fetch(errorPageUrl);
      const html = await res.text();

      expect(
        html,
        `The sign-in page at ${errorPageUrl} must include role="alert" on the error banner ` +
          `per docs/design/auth-and-onboarding.md §3A component hierarchy. ` +
          `The implementer must render <div role="alert"> for error=${errorParam}.`
      ).toContain('role="alert"');
    }
  });
});

// ---------------------------------------------------------------------------
// TOKEN FORMAT VALIDATION
// ---------------------------------------------------------------------------

describe("Malformed / garbage token — rejection", () => {
  it("GET /auth/verify with a garbage token string returns an error redirect, not 500", async () => {
    // Tests that the server handles malformed input gracefully.
    // The exact error param may be "expired" or a custom code; what matters
    // is no 500 and no session cookie is set.
    const garbageUrl = `${BASE_URL}${AUTH_ROUTES.callbackEmail}?token=this-is-not-a-real-token&email=${FRESH_EMAIL}`;
    const res = await fetch(garbageUrl, { redirect: "manual" });

    expect(
      res.status,
      `A garbage token submitted to ${AUTH_ROUTES.callbackEmail} must not return 500. ` +
        `Got ${res.status}. The NextAuth callback must validate the token before accepting it.`
    ).not.toBe(500);

    expect(
      res.status,
      `A garbage token must cause a redirect or a 4xx, not a 200 session creation. ` +
        `Got ${res.status}. The server must reject unrecognized tokens.`
    ).not.toBe(200);

    const cookie = res.headers.get("set-cookie") ?? "";
    const hasSession =
      cookie.toLowerCase().includes("next-auth") ||
      cookie.toLowerCase().includes("session");

    expect(
      hasSession,
      `A garbage token must NOT create a session. Got Set-Cookie: "${cookie}".`
    ).toBe(false);
  });
});
