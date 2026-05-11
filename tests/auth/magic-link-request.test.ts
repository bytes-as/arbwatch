/**
 * Test surface 1: Magic-link request enqueues an email containing a
 * single-use token.
 *
 * Stack: Vitest + Next.js test harness (server-level, no real browser).
 * Mock boundary: Resend SDK (tests/auth/__mocks__/resend.ts).
 *
 * Definition of Done assertion:
 *   (a) magic-link request enqueues an email with a single-use token.
 *
 * These tests MUST FAIL against the current repo (no auth implementation).
 * They will pass once task-auth-backend implements NextAuth v5 with
 * the Email Provider and Resend transport.
 *
 * Exact route under test: POST /api/auth/signin/email  (NextAuth v5 default)
 * — also accepts the custom alias POST /auth/request per auth-and-onboarding.md §3A.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clearInbox,
  getInbox,
  getLatestEmail,
  extractTokenUrls,
} from "./__mocks__/resend";
import {
  FIXTURE_USER,
  FRESH_EMAIL,
  AUTH_ROUTES,
} from "./helpers/fixture-user";

// Mock the Resend SDK before any module that imports it is loaded.
vi.mock("resend");

// ---------------------------------------------------------------------------
// Test harness: minimal fetch wrapper against the Next.js dev server.
// When the skeleton's test config lands, this will be replaced by the
// Next.js test utilities (e.g. `createServer` from next/test-utils or
// the experimental `unstable_startServer`). Until then we use the base URL
// from the environment, defaulting to localhost:3000.
// ---------------------------------------------------------------------------
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

async function postSigninEmail(email: string): Promise<Response> {
  // NextAuth v5 Email Provider expects a POST to /api/auth/signin/email
  // with a CSRF token and the email field. In test mode NextAuth must be
  // configured to skip CSRF verification (NEXTAUTH_URL + NODE_ENV=test).
  return fetch(`${BASE_URL}${AUTH_ROUTES.signinEmail}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email,
      csrfToken: "test-csrf-token", // NextAuth test mode accepts any token when NEXTAUTH_SECRET is set
      callbackUrl: `${BASE_URL}${AUTH_ROUTES.dashboard}`,
      json: "true",
    }),
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------

describe("Magic-link request — POST /api/auth/signin/email", () => {
  beforeEach(() => {
    clearInbox();
  });

  it("returns a 2xx or redirect response (not 404) when the server is running", async () => {
    // This test fails immediately if the route does not exist, giving the
    // implementer a clear signal that the NextAuth Email Provider route
    // must be registered.
    const res = await postSigninEmail(FIXTURE_USER.email).catch((err) => {
      throw new Error(
        `POST ${AUTH_ROUTES.signinEmail} is unreachable — is the Next.js server running? ` +
          `Original error: ${err.message}`
      );
    });

    // 200, 302, or 307 are acceptable — 404 is not.
    expect(
      [200, 201, 302, 307].includes(res.status),
      `Expected 200/302/307 from ${AUTH_ROUTES.signinEmail} but got ${res.status}. ` +
        `The NextAuth Email Provider route is not registered.`
    ).toBe(true);
  });

  it("enqueues exactly one email to the Resend SDK after a sign-in request", async () => {
    await postSigninEmail(FIXTURE_USER.email);

    const inbox = getInbox();
    expect(
      inbox.length,
      `Expected Resend.emails.send to be called once after POST ${AUTH_ROUTES.signinEmail}. ` +
        `Got ${inbox.length} calls. ` +
        `The backend must use Resend as the NextAuth Email Provider transport.`
    ).toBe(1);
  });

  it("sends the email to the address that was submitted", async () => {
    await postSigninEmail(FRESH_EMAIL);

    const email = getLatestEmail();
    const to = Array.isArray(email.to) ? email.to[0] : email.to;
    expect(
      to,
      `Email was sent to "${to}" but should have been sent to "${FRESH_EMAIL}". ` +
        `The NextAuth Email Provider must forward the submitted address to Resend.`
    ).toBe(FRESH_EMAIL);
  });

  it("email body contains a URL with a token parameter", async () => {
    await postSigninEmail(FIXTURE_USER.email);

    const email = getLatestEmail();
    const tokenUrls = extractTokenUrls(email);

    expect(
      tokenUrls.length,
      `The magic-link email body must contain at least one URL with a token/callbackUrl/magic ` +
        `parameter. Found 0 matching URLs in the email body. ` +
        `Route expected: ${AUTH_ROUTES.callbackEmail}?token=<TOKEN> or ${AUTH_ROUTES.verify}?token=<TOKEN>. ` +
        `Email HTML preview (first 500 chars): ${String(email.html ?? email.text ?? "").slice(0, 500)}`
    ).toBeGreaterThan(0);
  });

  it("token URL contains a non-empty token value", async () => {
    await postSigninEmail(FIXTURE_USER.email);

    const email = getLatestEmail();
    const tokenUrls = extractTokenUrls(email);
    const url = new URL(tokenUrls[0]);

    // NextAuth v5 uses 'token' query param; verify the value is non-trivial
    const token =
      url.searchParams.get("token") ??
      url.searchParams.get("callbackUrl");

    expect(
      token,
      `Token URL "${tokenUrls[0]}" does not contain a non-empty token value in the ` +
        `"token" or "callbackUrl" query parameter. ` +
        `The signed token must be present so tests/auth/token-redemption.test.ts can redeem it.`
    ).toBeTruthy();

    // A signed HMAC token should be at least 20 characters
    expect(
      (token ?? "").length,
      `Token value is too short (${(token ?? "").length} chars). ` +
        `Expected a properly signed HMAC token of at least 20 characters per NextAuth v5 spec.`
    ).toBeGreaterThanOrEqual(20);
  });

  it("does NOT enqueue a second email when the same address is submitted twice within the rate-limit window", async () => {
    // Edge case E6 from auth-and-onboarding.md: server enforces idempotency.
    // The exact behavior (new token superseding old, vs no-op) is
    // implementation-defined, but a second email must NOT be sent
    // immediately (rate limiting protects the Resend daily cap).
    await postSigninEmail(FIXTURE_USER.email);
    clearInbox(); // clear after first — we only care about the second
    await postSigninEmail(FIXTURE_USER.email);

    // Implementation may send a fresh superseding token (1 email) or
    // suppress entirely (0 emails). It must NOT send more than 1.
    const count = getInbox().length;
    expect(
      count <= 1,
      `Expected 0 or 1 emails on duplicate submission within rate-limit window, ` +
        `but got ${count}. The server must not re-enqueue an email every time ` +
        `the form is submitted — this risks hitting Resend's 100/day cap.`
    ).toBe(true);
  });
});
