/**
 * tests/key/isolation.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-key-backend implements the key API with per-user isolation
 *   - The middleware correctly scopes /api/me/* to the authenticated caller
 *   - lib/wire/decrypt.ts binds AAD = user.id so each ciphertext is tied to its row
 *
 * Test surfaces covered (per task-key-test brief §Backend):
 *   5. Two-user isolation:
 *      a. Wire call as user A carries A's plaintext, never B's.
 *      b. Wire call as user B carries B's plaintext, never A's.
 *      c. GET /api/me/anakin-key returns the caller's status, NEVER raw ciphertext.
 *      d. IDOR attempt: /api/me/anakin-key?user_id=<other> returns only the
 *         caller's own data (query parameter is ignored / rejected).
 *      e. A user without a key cannot read another user's key via any API endpoint.
 *
 * Architecture references:
 *   - ADR-0001 §"Encryption key": AAD = user.id binds ciphertext to its row.
 *     Decrypting user A's ciphertext with user B's id as AAD MUST fail (GCM auth tag mismatch).
 *   - ADR-0002 §"Per-call credential injection": the wrapper reads the session's userId,
 *     looks up that user's ciphertext, and decrypts with AAD = userId.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openTestDb,
  getAnakinKeyCt,
} from "./helpers/db-inspect";
import {
  FIXTURE_USER_WITH_KEY,
  FIXTURE_USER_NO_KEY,
  TEST_APP_ENCRYPTION_KEY,
  VALID_FORMAT_KEY,
  VALID_FORMAT_KEY_2,
  KEY_ROUTES,
} from "./helpers/fixture-key";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

/** Session for fixture user A (has a key; status = ok). */
const SESSION_A =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

/** Session for fixture user B (no key; status = key-missing). */
const SESSION_B =
  process.env.FIXTURE_SESSION_TOKEN_B ?? "fixture-session-token-b-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const dir = join(tmpdir(), "predmkt-arb-isolation-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `key-isolation-test-${process.pid}.db`);
}

function runSeed(targetDbPath: string): void {
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: `file:${targetDbPath}`,
      WIRE_MODE: "fixtures",
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "test",
    },
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
}

async function postAnakinKey(plaintext: string, sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${KEY_ROUTES.saveKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    body: JSON.stringify({ key: plaintext }),
    redirect: "manual",
  });
}

/** GET /api/me/anakin-key — must return status, NEVER raw ciphertext bytes. */
async function getKeyStatus(sessionToken: string, queryParams?: string): Promise<Response> {
  const url = `${BASE_URL}${KEY_ROUTES.keyStatus}${queryParams ? `?${queryParams}` : ""}`;
  return fetch(url, {
    method: "GET",
    headers: {
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    redirect: "manual",
  });
}

async function triggerWireCallAs(userId: string, sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/me/anakin-key/probe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `next-auth.session-token=${sessionToken}`,
      "X-Test-Observe-Auth-Header": "true",
    },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// Suite 5: Two-user isolation (DoD item 5)
// ---------------------------------------------------------------------------

describe("Two-user isolation — keys are scoped per user", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath();
    // The seed must insert BOTH fixture users from tests/seeds/queries.yaml:
    //   user A: id = FIXTURE_USER_WITH_KEY.id, has a key
    //   user B: id = FIXTURE_USER_NO_KEY.id,   no key
    runSeed(dbPath);
    db = await openTestDb(dbPath);

    // Give user A a fresh key for this test suite
    await postAnakinKey(VALID_FORMAT_KEY, SESSION_A);
    // Give user B a different key (user B has no key by default; save one)
    await postAnakinKey(VALID_FORMAT_KEY_2, SESSION_B);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  // 5a: Wire call as user A carries A's key
  it("Wire call as user A carries user A's plaintext key", async () => {
    const res = await triggerWireCallAs(FIXTURE_USER_WITH_KEY.id, SESSION_A);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const authHeader = (body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? "") as string;

    expect(
      authHeader,
      `Wire call as user A must send A's key in the auth header. ` +
        `Expected "Bearer ${VALID_FORMAT_KEY}" but got "${authHeader}". ` +
        `ADR-0002: the wrapper reads users.anakin_key_ct WHERE id = session.userId.`
    ).toBe(`Bearer ${VALID_FORMAT_KEY}`);
  });

  // 5a: Wire call as user A does NOT carry B's key
  it("Wire call as user A does NOT carry user B's key", async () => {
    const res = await triggerWireCallAs(FIXTURE_USER_WITH_KEY.id, SESSION_A);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const authHeader = (body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? "") as string;

    expect(
      authHeader.includes(VALID_FORMAT_KEY_2),
      `Wire call as user A carries user B's key "${VALID_FORMAT_KEY_2}" in the auth header. ` +
        `This is a cross-user credential leak. ` +
        `Auth header observed: "${authHeader}". ` +
        `ADR-0001: AAD = user.id prevents cross-user decryption at the crypto level.`
    ).toBe(false);
  });

  // 5b: Wire call as user B carries B's key
  it("Wire call as user B carries user B's plaintext key", async () => {
    const res = await triggerWireCallAs(FIXTURE_USER_NO_KEY.id, SESSION_B);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const authHeader = (body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? "") as string;

    expect(
      authHeader,
      `Wire call as user B must send B's key in the auth header. ` +
        `Expected "Bearer ${VALID_FORMAT_KEY_2}" but got "${authHeader}". ` +
        `The Wire wrapper must use the session user's own ciphertext row.`
    ).toBe(`Bearer ${VALID_FORMAT_KEY_2}`);
  });

  // 5b: Wire call as user B does NOT carry A's key
  it("Wire call as user B does NOT carry user A's key", async () => {
    const res = await triggerWireCallAs(FIXTURE_USER_NO_KEY.id, SESSION_B);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const authHeader = (body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? "") as string;

    expect(
      authHeader.includes(VALID_FORMAT_KEY),
      `Wire call as user B carries user A's key "${VALID_FORMAT_KEY}" in the auth header. ` +
        `This is a cross-user credential leak. Auth header: "${authHeader}".`
    ).toBe(false);
  });

  // 5c: GET /api/me/anakin-key returns status, not raw ciphertext
  it("GET /api/me/anakin-key returns the caller's status, not the raw ciphertext bytes", async () => {
    const res = await getKeyStatus(SESSION_A);
    expect(
      [200, 201].includes(res.status),
      `GET ${KEY_ROUTES.keyStatus} returned ${res.status}. Expected 200.`
    ).toBe(true);

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const bodyStr = JSON.stringify(body);

    // The response must include status
    expect(
      body.status ?? body.anakin_key_status,
      `GET ${KEY_ROUTES.keyStatus} body does not include a "status" field. ` +
        `The endpoint must return the caller's anakin_key_status.`
    ).toBeTruthy();

    // The response must NOT include raw ciphertext bytes
    const ct = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    if (ct) {
      const ctHex = ct.toString("hex");
      const ctBase64 = ct.toString("base64");
      expect(
        bodyStr.includes(ctHex) || bodyStr.includes(ctBase64),
        `GET ${KEY_ROUTES.keyStatus} response contains the raw ciphertext (hex or base64). ` +
          `The endpoint must never expose the encrypted ciphertext bytes to the client. ` +
          `Response body (first 500 chars): ${bodyStr.slice(0, 500)}`
      ).toBe(false);
    }
  });

  // 5d: IDOR attempt — ?user_id=<other-user> is ignored
  it("IDOR attempt: GET /api/me/anakin-key?user_id=<other> returns only the caller's data", async () => {
    // User A requests their status but injects user B's id as a query parameter
    const res = await getKeyStatus(
      SESSION_A,
      `user_id=${FIXTURE_USER_NO_KEY.id}`
    );

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const returnedStatus = (body.status ?? body.anakin_key_status ?? "") as string;

    // User A's status is "ok"; user B's status is "key-missing"
    // The response must reflect user A's actual status ("ok"), not user B's ("key-missing")
    expect(
      returnedStatus,
      `IDOR attempt: GET /api/me/anakin-key?user_id=${FIXTURE_USER_NO_KEY.id} as user A ` +
        `returned status="${returnedStatus}" instead of user A's own status="ok". ` +
        `The endpoint must ignore the user_id query parameter and always return ` +
        `the authenticated caller's data. This is a horizontal privilege escalation risk.`
    ).toBe("ok");
  });

  // 5d: IDOR attempt — ensure user B's ciphertext is not returned to user A
  it("IDOR attempt: ciphertext for user B is never returned to user A", async () => {
    const ctB = getAnakinKeyCt(db, FIXTURE_USER_NO_KEY.id);

    // User A tries to retrieve user B's data via a user_id param injection
    const res = await getKeyStatus(SESSION_A, `user_id=${FIXTURE_USER_NO_KEY.id}`);
    const bodyStr = await res.text().catch(() => "");

    if (ctB) {
      const ctBHex = ctB.toString("hex");
      const ctBBase64 = ctB.toString("base64");
      expect(
        bodyStr.includes(ctBHex) || bodyStr.includes(ctBBase64),
        `User A's request returned user B's ciphertext (hex or base64). ` +
          `The endpoint must never expose another user's ciphertext. ` +
          `Response body (first 500 chars): ${bodyStr.slice(0, 500)}`
      ).toBe(false);
    }
  });

  // 5e: User without a key cannot read another user's key
  it("unauthenticated request (no session) returns 401, not another user's data", async () => {
    const res = await fetch(`${BASE_URL}${KEY_ROUTES.keyStatus}`, {
      method: "GET",
      redirect: "manual",
      // No Cookie header — simulates a logged-out or unauthenticated request
    });

    expect(
      [401, 403, 302, 307].includes(res.status),
      `GET ${KEY_ROUTES.keyStatus} without a session returned ${res.status}. ` +
        `Expected 401/403 (or a redirect to /signin). ` +
        `The endpoint must require authentication.`
    ).toBe(true);

    // If it returned any success status, check the body doesn't leak data
    if (res.status < 400 && res.status >= 200) {
      const body = await res.text().catch(() => "");
      const ctA = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
      if (ctA) {
        expect(
          body.includes(ctA.toString("hex")) || body.includes(ctA.toString("base64")),
          `Unauthenticated GET returned user A's ciphertext. ` +
            `The endpoint must require authentication.`
        ).toBe(false);
      }
    }
  });

  // AAD cross-decryption: assert that user A's ciphertext cannot be decrypted with user B's id
  it("user A ciphertext decryption with user B id (AAD mismatch) must fail", async () => {
    // This test imports the decrypt helper directly to assert the AAD binds the ciphertext
    // to the correct user.
    //
    // The implementer's lib/wire/decrypt.ts must export:
    //   decryptAESGCM({ ct: Buffer, aad: string, key: string }) → string
    //
    // Passing the wrong AAD (user B's id instead of user A's id) must throw or return garbage.
    // The GCM auth tag verification will fail.
    const decryptModule = await import("../../lib/wire/decrypt").catch(() => null);

    if (!decryptModule) {
      // Expected Mode 1 failure — lib/wire/decrypt.ts does not exist yet
      throw new Error(
        "lib/wire/decrypt.ts does not exist. " +
          "The implementer must create this module per ADR-0002 §'Module layout'. " +
          "It must export decryptAESGCM({ ct, aad, key }) → string."
      );
    }

    const { decryptAESGCM } = decryptModule;
    expect(
      typeof decryptAESGCM,
      "lib/wire/decrypt.ts must export a decryptAESGCM function"
    ).toBe("function");

    const ctA = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(ctA, "Pre-condition: user A must have a stored ciphertext").not.toBeNull();

    // Attempt to decrypt user A's ciphertext with user B's id as the AAD
    await expect(
      async () => {
        await decryptAESGCM({
          ct: ctA!,
          aad: FIXTURE_USER_NO_KEY.id, // wrong AAD — should fail
          key: TEST_APP_ENCRYPTION_KEY,
        });
      },
      `Decrypting user A's ciphertext with user B's id as AAD succeeded — the GCM auth tag ` +
        `verification did not catch the AAD mismatch. ` +
        `ADR-0001: AAD = user.id binds the ciphertext to its row. ` +
        `A cross-user decryption attempt must throw an authentication error.`
    ).rejects.toThrow();
  });
});
