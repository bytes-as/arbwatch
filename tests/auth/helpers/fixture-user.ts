/**
 * Fixture user constants for auth tests.
 *
 * The skeleton seed (task-skeleton-test / task-skeleton-impl) is expected to
 * insert this user into the seeded SQLite database before tests run.
 * These constants must match the seed exactly so auth tests can reference
 * a known identity without creating side-effect data.
 *
 * anakin_key_status = "ok" so the fixture user skips /onboarding/key
 * and lands directly on /dashboard after signing in.
 */
export const FIXTURE_USER = {
  email: "fixture@arbwatch.test",
  /** Expected to match the seeded row's primary key */
  id: "fixture-user-001",
  anakin_key_status: "ok" as const,
} as const;

/** A fresh email address that does NOT exist in the seed, used for new-user tests. */
export const FRESH_EMAIL = "newuser@arbwatch.test";

/**
 * Token TTL committed by ADR-0001 via the check-email copy in
 * docs/design/auth-and-onboarding.md §3B ("Link expires in 15 minutes").
 * Unit: milliseconds.
 */
export const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Session max-age committed by ADR-0001:
 *   "cookie max-age = 30 days" (Sessions section)
 * Unit: seconds (matching the Set-Cookie Max-Age attribute).
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * UX-spec'd error copy from docs/design/auth-and-onboarding.md §5A.
 * Tests assert against these exact strings so the frontend implementation
 * is locked to the design spec.
 */
export const ERROR_COPY = {
  expired:
    "That sign-in link has expired. Enter your email below to get a new one.",
  used: "That sign-in link has already been used. Enter your email below to get a new one.",
  server: "Something went wrong on our end. Please try again.",
} as const;

/**
 * NextAuth v5 route paths.
 * Tests reference these explicitly so the implementer knows the exact
 * surfaces being tested.
 */
export const AUTH_ROUTES = {
  /** NextAuth Email Provider sign-in POST — enqueues the magic-link email */
  signinEmail: "/api/auth/signin/email",
  /** NextAuth Email Provider callback — validates token, creates session */
  callbackEmail: "/api/auth/callback/email",
  /** Custom verify route per UX spec (docs/design/auth-and-onboarding.md §3D) */
  verify: "/auth/verify",
  /** Sign-in page */
  signin: "/signin",
  /** Check-email intermediate page */
  checkEmail: "/check-email",
  /** Post-auth landing for users with a key */
  dashboard: "/dashboard",
  /** Post-auth landing for users without a key */
  onboardingKey: "/onboarding/key",
  /** Auth-state probe endpoint — returns current user identity */
  me: "/api/me",
  /** NextAuth session endpoint */
  session: "/api/auth/session",
} as const;
