/**
 * tests/key/helpers/fixture-key.ts
 *
 * Constants for key-storage tests.  Extends tests/auth/helpers/fixture-user.ts
 * with key-specific constants and UX-spec'd copy strings.
 *
 * Sources:
 *   - tests/seeds/queries.yaml       — user ids and emails
 *   - docs/design/auth-and-onboarding.md §5C, §5D — inline error copy
 *   - docs/design/dashboard.md §5F   — banner copy (supersedes §5D of onboarding spec)
 *   - docs/architecture/0002-wire-integration.md — error taxonomy
 */

// ---------------------------------------------------------------------------
// Seed fixture users (mirror of tests/seeds/queries.yaml)
// ---------------------------------------------------------------------------

/** Primary fixture user: has an Anakin key, status = "ok". */
export const FIXTURE_USER_WITH_KEY = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "fixture@predmkt-arb.test",
  anakin_key_status: "ok" as const,
  /**
   * The deterministic plaintext key encrypted by the seed script.
   * Used to assert that the ciphertext stored in the DB differs from this string.
   * ADR-0001: encrypted with test APP_ENCRYPTION_KEY = 32 zero bytes (base64).
   */
  plaintext_key: "fixture-anakin-key-for-testing-only",
} as const;

/** Secondary fixture user: no Anakin key, status = "key-missing". */
export const FIXTURE_USER_NO_KEY = {
  id: "00000000-0000-0000-0000-000000000002",
  email: "nokey@predmkt-arb.test",
  anakin_key_status: "key-missing" as const,
} as const;

// ---------------------------------------------------------------------------
// Encryption constants (ADR-0001 §Locked-in specifics)
// ---------------------------------------------------------------------------

/**
 * Test APP_ENCRYPTION_KEY: 32 zero bytes, base64-encoded.
 * The seed script uses this value; test helpers that encrypt/decrypt must also
 * use this value via the APP_ENCRYPTION_KEY env var.
 */
export const TEST_APP_ENCRYPTION_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * Minimum valid ciphertext byte length per ADR-0001:
 *   nonce(12) + min 1 byte ciphertext + tag(16) = 29 bytes minimum.
 */
export const MIN_CIPHERTEXT_BYTES = 29;

/**
 * A syntactically valid Anakin API key used in POST tests.
 * Must satisfy the format validation defined in ADR-0002 (minimum length etc.).
 * The exact format minimum is 20 characters.
 * This key is NOT a real Anakin key and will always fail a live probe.
 */
export const VALID_FORMAT_KEY = "ak_test_1234567890abcdef";

/**
 * A second syntactically valid key (different from VALID_FORMAT_KEY).
 * Used for rotation tests: POST this key after VALID_FORMAT_KEY and assert
 * the stored ciphertext changes.
 */
export const VALID_FORMAT_KEY_2 = "ak_test_abcdef1234567890";

// ---------------------------------------------------------------------------
// Invalid key samples (for format-rejection tests)
// ---------------------------------------------------------------------------

export const INVALID_KEYS = {
  /** Empty string — clearly invalid. */
  empty: "",
  /** Whitespace only — client strips, but still empty after strip. */
  whitespace: "   \t\n  ",
  /**
   * Too short — below the Anakin format minimum of 20 characters.
   * ADR-0002 does not publish the exact format; 8 chars is safely below any
   * reasonable minimum.
   */
  tooShort: "ak_test1",
  /**
   * A key whose format passes length but is structurally wrong
   * (no expected prefix).  Used to test server-side format rejection.
   */
  badFormat: "this-is-not-an-anakin-key-at-all-!!",
} as const;

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

export const KEY_ROUTES = {
  /** Save (or replace) the user's Anakin API key. */
  saveKey: "/api/me/anakin-key",
  /** Remove the user's Anakin API key. */
  deleteKey: "/api/me/anakin-key",
  /** Read the caller's key status (never raw ciphertext). */
  keyStatus: "/api/me/anakin-key",
} as const;

// ---------------------------------------------------------------------------
// UX-spec'd copy strings
// ---------------------------------------------------------------------------

/**
 * Onboarding key page copy — docs/design/auth-and-onboarding.md §5C.
 * Tests assert these exact strings appear in the UI so the frontend
 * implementation is locked to the design spec.
 */
export const ONBOARDING_COPY = {
  /** Page <h1> */
  heading: "Connect your Anakin API key",
  /** Submit button label (idle) */
  submitButton: "Save key",
  /** Show/hide toggle — hidden state */
  showKey: "Show key",
  /** Show/hide toggle — shown state */
  hideKey: "Hide key",
  /** Input placeholder */
  inputPlaceholder: "Paste your key here",
  /** Input label */
  inputLabel: "Anakin API key",

  /** Inline errors (below input, role="alert") */
  errors: {
    /**
     * Client-side format validation failure.
     * docs/design/auth-and-onboarding.md §5C
     */
    formatInvalid:
      "That doesn't look like a valid Anakin API key. Check for extra spaces or missing characters.",
    /**
     * Server rejected the key (probe returned key-invalid).
     * docs/design/auth-and-onboarding.md §5C
     */
    keyInvalid:
      "Anakin rejected this key. Double-check it in your Anakin dashboard and paste it again.",
    /**
     * Server probe returned quota-exhausted.
     * docs/design/auth-and-onboarding.md §5C
     */
    quotaExhausted:
      "Your Anakin account has no remaining Wire quota. Top up your balance at anakin.company/wire, then paste your key again.",
    /** Generic server error (5xx etc.) */
    generic: "Something went wrong saving your key. Try again in a moment.",
  },
} as const;

/**
 * Dashboard banner copy — docs/design/dashboard.md §5F.
 * These supersede the draft copy in auth-and-onboarding.md §5D.
 */
export const DASHBOARD_BANNER_COPY = {
  /** Banner heading — shared across all three error states. */
  heading: "Wire calls paused",
  /** body for key-missing state */
  keyMissing:
    "Add an Anakin key in Settings to start watching markets.",
  /** body for key-invalid state */
  keyInvalid:
    "Your Anakin key was rejected — paste a fresh one in Settings.",
  /**
   * body for quota-exhausted when no cooldown_ends_at is available.
   * Tests assert this fallback string because the test fixture does not
   * provide a cooldown timestamp.
   */
  quotaExhaustedFallback:
    "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin account at anakin.company/wire to resume.",
  /** CTA link text */
  ctaText: "Update key",
} as const;

/**
 * Dashboard empty-state copy — docs/design/dashboard.md §5C.
 */
export const DASHBOARD_EMPTY_STATE_COPY = {
  heading: "You're not watching any questions yet.",
  subtext: "Type a question above to start tracking spreads.",
} as const;

/**
 * Welcome toast copy — docs/design/auth-and-onboarding.md §5E.
 */
export const WELCOME_TOAST_COPY =
  "You're all set. Start watching your first question below.";

// ---------------------------------------------------------------------------
// Valid status enum values (ADR-0002)
// ---------------------------------------------------------------------------

export const VALID_KEY_STATUSES = [
  "ok",
  "key-missing",
  "key-invalid",
  "quota-exhausted",
] as const;

export type AnakinKeyStatus = (typeof VALID_KEY_STATUSES)[number];
