/**
 * tests/key/rotation.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-key-backend implements POST /api/me/anakin-key (replace/rotate key)
 *   - task-key-backend implements DELETE /api/me/anakin-key
 *   - lib/wire/client.ts (Wire wrapper) is implemented with decrypt-on-demand
 *   - lib/wire/decrypt.ts implements getDecryptedAnakinKey(userId)
 *   - WIRE_MODE=fixtures is honoured by the Wire wrapper
 *
 * Test surfaces covered (per task-key-test brief §Backend):
 *   2. Decrypt-on-call only — Wire client auth header carries the plaintext key
 *      ONLY inside the call frame; plaintext never appears in log output.
 *   3. Key rotation — second POST replaces the first ciphertext; cached Wire
 *      client is invalidated so the next call decrypts the NEW ciphertext.
 *   4. Key removal — DELETE sets anakin_key_ct = null, anakin_key_status = "key-missing";
 *      subsequent Wire call is blocked with key-missing (no HTTP attempt).
 *
 * Wire call observation strategy (per ADR-0002 §"Local-dev fixture mode"):
 *   Set WIRE_MODE=fixtures and stub the fixture loader to capture the auth
 *   header that the Wire wrapper would pass.  Because fixture mode short-circuits
 *   before HTTP, the test never hits the network.
 *
 *   We expose the observation point via a module-level singleton that the
 *   Wire wrapper must call when WIRE_MODE=fixtures and NODE_ENV=test:
 *     import { recordWireCall } from "lib/wire/fixtures";
 *   The implementer must call recordWireCall({ authHeader }) inside the
 *   fixture branch of the wrapper.  This test then imports that singleton
 *   and asserts on it.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openTestDb,
  getAnakinKeyCt,
  getAnakinKeyStatus,
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
const FIXTURE_SESSION_TOKEN_A =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";
const FIXTURE_SESSION_TOKEN_B =
  process.env.FIXTURE_SESSION_TOKEN_B ?? "fixture-session-token-b-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const dir = join(tmpdir(), "predmkt-arb-rotation-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `key-rotation-test-${process.pid}.db`);
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

async function deleteAnakinKey(sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${KEY_ROUTES.deleteKey}`, {
    method: "DELETE",
    headers: {
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    redirect: "manual",
  });
}

/**
 * Trigger a Wire call via the /api/cron/refresh-spreads endpoint (or a
 * dedicated /api/me/probe endpoint if one exists).
 * The Wire wrapper must be in WIRE_MODE=fixtures so no HTTP goes out.
 *
 * Returns the full response so tests can inspect headers and body.
 */
async function triggerWireCall(userId: string, sessionToken: string): Promise<Response> {
  // Try the per-user probe endpoint first (written in task-key-backend).
  // Fallback to a test-only route if the probe endpoint is not available.
  return fetch(`${BASE_URL}/api/me/anakin-key/probe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `next-auth.session-token=${sessionToken}`,
      "X-Test-Observe-Auth-Header": "true", // implementer must echo the auth header back in test mode
    },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// Suite 2: Decrypt-on-call only (DoD item 2)
// ---------------------------------------------------------------------------

describe("Decrypt-on-call only — Wire auth header carries plaintext, not logs", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath();
    runSeed(dbPath);
    db = await openTestDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("after saving a key, triggering a Wire call returns a probe-observed auth header", async () => {
    // Save a key first
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    // Trigger a Wire call and ask the server to echo the auth header it would send
    const res = await triggerWireCall(FIXTURE_USER_WITH_KEY.id, FIXTURE_SESSION_TOKEN_A).catch(
      (err) => {
        throw new Error(
          `POST /api/me/anakin-key/probe is unreachable — is the server running? ` +
            `Error: ${err.message}`
        );
      }
    );

    // The probe endpoint must exist (not 404)
    expect(
      res.status,
      `POST /api/me/anakin-key/probe returned ${res.status}. ` +
        `The probe endpoint must be implemented so tests can observe the Wire auth header. ` +
        `ADR-0002 §"Probe path": same wrapper, but with the freshly pasted plaintext key.`
    ).not.toBe(404);
  });

  it("Wire call auth header contains the plaintext key (decrypted from ciphertext)", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const res = await triggerWireCall(FIXTURE_USER_WITH_KEY.id, FIXTURE_SESSION_TOKEN_A);
    // The implementer must echo the auth header in the response body when
    // NODE_ENV=test and WIRE_MODE=fixtures and X-Test-Observe-Auth-Header=true.
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const observedAuthHeader = (body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? "") as string;

    expect(
      observedAuthHeader,
      `The probe response did not include the "observedAuthHeader" field. ` +
        `The implementer must echo the Wire auth header in the response body when ` +
        `NODE_ENV=test && WIRE_MODE=fixtures && X-Test-Observe-Auth-Header=true is set. ` +
        `Got body: ${JSON.stringify(body).slice(0, 500)}`
    ).toBeTruthy();

    // The auth header must be of the form "Bearer <plaintext>"
    expect(
      observedAuthHeader,
      `The Wire auth header "${observedAuthHeader}" must be "Bearer ${VALID_FORMAT_KEY}". ` +
        `ADR-0002 §"Per-call credential injection": the wrapper sets ` +
        `Authorization: Bearer \${plaintext} on the outgoing fetch.`
    ).toBe(`Bearer ${VALID_FORMAT_KEY}`);
  });

  it("plaintext key does NOT appear in any logger output during the Wire call", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    // Capture log output during the Wire call
    let capturedOutput = "";
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: any, ...args: any[]) => {
      capturedOutput += String(chunk);
      return originalStdoutWrite(chunk, ...args);
    };
    process.stderr.write = (chunk: any, ...args: any[]) => {
      capturedOutput += String(chunk);
      return originalStderrWrite(chunk, ...args);
    };

    try {
      await triggerWireCall(FIXTURE_USER_WITH_KEY.id, FIXTURE_SESSION_TOKEN_A);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(
      capturedOutput.includes(VALID_FORMAT_KEY),
      `The plaintext key "${VALID_FORMAT_KEY}" appeared in logger output during the Wire call. ` +
        `ADR-0002 §"Per-call credential injection" (d): "The plaintext is never logged, never returned, ` +
        `never put in an error message, never JSON-stringified." ` +
        `Captured output (first 1000 chars): ${capturedOutput.slice(0, 1000)}`
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Key rotation (DoD item 3)
// ---------------------------------------------------------------------------

describe("Key rotation — second POST replaces first ciphertext", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath();
    runSeed(dbPath);
    db = await openTestDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST with a second key replaces (not appends) the stored ciphertext", async () => {
    // Save key 1
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    const ct1 = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(ct1, "Pre-condition: first key must be stored").not.toBeNull();

    // Rotate to key 2
    const rotateRes = await postAnakinKey(VALID_FORMAT_KEY_2, FIXTURE_SESSION_TOKEN_A);
    expect(
      [200, 201].includes(rotateRes.status),
      `Key rotation POST returned ${rotateRes.status}. Expected 200 or 201.`
    ).toBe(true);

    const ct2 = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(ct2, "After rotation, ciphertext must not be null").not.toBeNull();

    // The second ciphertext must differ from the first
    expect(
      Buffer.compare(ct1!, ct2!),
      `The stored ciphertext is unchanged after rotating to a new key. ` +
        `POST ${KEY_ROUTES.saveKey} with a new plaintext must overwrite the previous ciphertext. ` +
        `The old and new ciphertext bytes are identical, which means either ` +
        `(a) the rotation call failed silently, or ` +
        `(b) the deterministic nonce produced the same ciphertext (nonce MUST be random per ADR-0001).`
    ).not.toBe(0);
  });

  it("after rotation, second ciphertext does NOT contain the first plaintext", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await postAnakinKey(VALID_FORMAT_KEY_2, FIXTURE_SESSION_TOKEN_A);

    const ct2 = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    const ct2String = ct2!.toString("utf8");

    expect(
      ct2String.includes(VALID_FORMAT_KEY),
      `The first plaintext key "${VALID_FORMAT_KEY}" appears in the post-rotation ciphertext. ` +
        `The rotation must fully replace the old ciphertext with a fresh encryption of the new key.`
    ).toBe(false);
  });

  it("after rotation, second ciphertext does NOT contain the second plaintext", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await postAnakinKey(VALID_FORMAT_KEY_2, FIXTURE_SESSION_TOKEN_A);

    const ct2 = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    const ct2String = ct2!.toString("utf8");

    expect(
      ct2String.includes(VALID_FORMAT_KEY_2),
      `The second plaintext key "${VALID_FORMAT_KEY_2}" appears verbatim in the stored ciphertext. ` +
        `The key must be AES-256-GCM encrypted; plaintext must not be stored.`
    ).toBe(false);
  });

  it("after rotation, the Wire call uses the NEW key (decrypts updated ciphertext)", async () => {
    // Save key 1, then rotate to key 2
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await postAnakinKey(VALID_FORMAT_KEY_2, FIXTURE_SESSION_TOKEN_A);

    // Trigger a Wire call and observe the auth header
    const res = await triggerWireCall(FIXTURE_USER_WITH_KEY.id, FIXTURE_SESSION_TOKEN_A);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const observedAuthHeader = (body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? "") as string;

    expect(
      observedAuthHeader,
      `After rotation, the Wire call must use the new key. ` +
        `Expected auth header: "Bearer ${VALID_FORMAT_KEY_2}". ` +
        `Got: "${observedAuthHeader}". ` +
        `ADR-0002: the Wire wrapper must decrypt-on-demand (not use a cached plaintext from before rotation).`
    ).toBe(`Bearer ${VALID_FORMAT_KEY_2}`);

    // Also assert the OLD key is NOT sent
    expect(
      observedAuthHeader.includes(VALID_FORMAT_KEY) && !observedAuthHeader.includes(VALID_FORMAT_KEY_2),
      `After rotation, the Wire call is still using the OLD key "${VALID_FORMAT_KEY}". ` +
        `Any in-process cached Wire client must be invalidated on key rotation. ` +
        `ADR-0002: retry re-decrypts, meaning no plaintext is cached across calls.`
    ).toBe(false);
  });

  it("status remains 'ok' after a successful rotation", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await postAnakinKey(VALID_FORMAT_KEY_2, FIXTURE_SESSION_TOKEN_A);

    const status = getAnakinKeyStatus(db, FIXTURE_USER_WITH_KEY.id);
    expect(status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Key removal (DoD item 4)
// ---------------------------------------------------------------------------

describe("Key removal — DELETE /api/me/anakin-key", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath();
    runSeed(dbPath);
    db = await openTestDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("DELETE /api/me/anakin-key returns 200 or 204 (route exists)", async () => {
    // Save a key first, then delete it
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const res = await deleteAnakinKey(FIXTURE_SESSION_TOKEN_A).catch((err) => {
      throw new Error(
        `DELETE ${KEY_ROUTES.deleteKey} is unreachable. ` +
          `Error: ${err.message}`
      );
    });
    expect(
      [200, 204].includes(res.status),
      `DELETE ${KEY_ROUTES.deleteKey} returned ${res.status}. Expected 200 or 204.`
    ).toBe(true);
  });

  it("after DELETE, users.anakin_key_ct is null", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await deleteAnakinKey(FIXTURE_SESSION_TOKEN_A);

    const ct = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      ct,
      `users.anakin_key_ct is still non-null after DELETE ${KEY_ROUTES.deleteKey}. ` +
        `The backend must set anakin_key_ct = NULL on key removal.`
    ).toBeNull();
  });

  it('after DELETE, anakin_key_status is "key-missing"', async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await deleteAnakinKey(FIXTURE_SESSION_TOKEN_A);

    const status = getAnakinKeyStatus(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      status,
      `users.anakin_key_status is "${status}" after DELETE ${KEY_ROUTES.deleteKey}. ` +
        `The backend must set anakin_key_status = "key-missing" on key removal. ` +
        `ADR-0002 §"Error taxonomy": key-missing = no anakin_key_ct.`
    ).toBe("key-missing");
  });

  it("after DELETE, a Wire call attempt is blocked with key-missing (no HTTP)", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    await deleteAnakinKey(FIXTURE_SESSION_TOKEN_A);

    // Attempt a Wire call — must fail with key-missing, not attempt HTTP
    const res = await triggerWireCall(FIXTURE_USER_WITH_KEY.id, FIXTURE_SESSION_TOKEN_A);

    // The probe must not return 2xx (which would indicate a Wire call succeeded)
    // It should return 400 or 422 with a key-missing error body
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errorTag = body.error ?? body.errorTag ?? body.code ?? "";
    const bodyStr = JSON.stringify(body);

    expect(
      bodyStr.includes("key-missing") ||
        errorTag === "key-missing" ||
        res.status === 400 ||
        res.status === 422,
      `After key removal, the Wire probe did not return a key-missing error. ` +
        `Got status ${res.status} and body: ${bodyStr.slice(0, 500)}. ` +
        `ADR-0002 §"Error taxonomy" (key-missing): "users.anakin_key_ct IS NULL (no Wire call attempted)". ` +
        `The wrapper must check for a null ciphertext and return key-missing before making any HTTP call.`
    ).toBe(true);
  });
});
