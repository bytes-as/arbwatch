/**
 * tests/key/encryption.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-key-backend implements POST /api/me/anakin-key
 *   - task-key-backend implements DELETE /api/me/anakin-key
 *   - The Drizzle schema has users.anakin_key_ct (bytea / blob) and
 *     users.anakin_key_status (enum: ok | key-missing | key-invalid | quota-exhausted)
 *     and users.anakin_key_status_at (timestamp).
 *   - The AES-256-GCM encrypt/decrypt helpers in lib/wire/decrypt.ts are implemented.
 *   - scripts/seed.ts seeds the two fixture users from tests/seeds/queries.yaml.
 *
 * Test surfaces covered (per task-key-test brief §Backend):
 *   1. Encryption-at-rest: POST /api/me/anakin-key stores a ciphertext, NOT the plaintext.
 *   6. Invalid-format rejection: POST with bad key returns 400, preserves existing key.
 *   7. Status enum integrity: DB rejects values outside the four documented states.
 *   8. No-log assertion: plaintext key never appears in captured log output.
 *
 * Architecture references:
 *   - ADR-0001 §"Encryption key": nonce(12) || ciphertext || tag(16), AAD = user.id
 *   - ADR-0002 §"Error taxonomy": four valid status values
 *   - docs/design/auth-and-onboarding.md §5C: error copy strings
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
  getAnakinKeyStatus,
  getAnakinKeyStatusAt,
  tryWriteInvalidStatus,
} from "./helpers/db-inspect";
import {
  FIXTURE_USER_WITH_KEY,
  FIXTURE_USER_NO_KEY,
  TEST_APP_ENCRYPTION_KEY,
  MIN_CIPHERTEXT_BYTES,
  VALID_FORMAT_KEY,
  VALID_FORMAT_KEY_2,
  INVALID_KEYS,
  KEY_ROUTES,
  ONBOARDING_COPY,
  VALID_KEY_STATUSES,
} from "./helpers/fixture-key";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Shared test DB setup
// ---------------------------------------------------------------------------

let dbPath: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

/** Session tokens that the seed script must insert for each fixture user. */
const FIXTURE_SESSION_TOKEN_A =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";
const FIXTURE_SESSION_TOKEN_B =
  process.env.FIXTURE_SESSION_TOKEN_B ?? "fixture-session-token-b-do-not-use-in-prod";

function makeTempDbPath(): string {
  const dir = join(tmpdir(), "predmkt-arb-key-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `key-encryption-test-${process.pid}.db`);
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

/** POST to /api/me/anakin-key as a given fixture user (via session cookie). */
async function postAnakinKey(
  plaintext: string,
  sessionToken: string
): Promise<Response> {
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

/** DELETE /api/me/anakin-key as a given fixture user. */
async function deleteAnakinKey(sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${KEY_ROUTES.deleteKey}`, {
    method: "DELETE",
    headers: {
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

/**
 * Captures console output during a callback and returns all output as a string.
 * Used to assert that plaintext keys never appear in logger output.
 *
 * The implementer's Pino redact path must scrub:
 *   ["headers.authorization", "*.apiKey", "*.api_key", "*.anakin_key"]
 * (per ADR-0002 §"Per-call credential injection").
 */
let capturedLogOutput = "";

function startLogCapture(): void {
  capturedLogOutput = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  (process.stdout as any)._captureWrite = originalWrite;
  (process.stderr as any)._captureWrite = originalErrWrite;
  process.stdout.write = (chunk: any, ...args: any[]) => {
    capturedLogOutput += String(chunk);
    return originalWrite(chunk, ...args);
  };
  process.stderr.write = (chunk: any, ...args: any[]) => {
    capturedLogOutput += String(chunk);
    return originalErrWrite(chunk, ...args);
  };
}

function stopLogCapture(): string {
  if ((process.stdout as any)._captureWrite) {
    process.stdout.write = (process.stdout as any)._captureWrite;
    delete (process.stdout as any)._captureWrite;
  }
  if ((process.stderr as any)._captureWrite) {
    process.stderr.write = (process.stderr as any)._captureWrite;
    delete (process.stderr as any)._captureWrite;
  }
  return capturedLogOutput;
}

// ---------------------------------------------------------------------------
// Suite 1: Encryption-at-rest (DoD item 1)
// ---------------------------------------------------------------------------

describe("Encryption-at-rest — POST /api/me/anakin-key", () => {
  beforeAll(async () => {
    dbPath = makeTempDbPath();
    // This will throw (ENOENT or non-zero exit) until scripts/seed.ts exists.
    // That is the expected Mode 1 failure.
    runSeed(dbPath);
    db = await openTestDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    db = undefined as any;
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST /api/me/anakin-key returns 200 or 201 (route exists)", async () => {
    const res = await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A).catch(
      (err) => {
        throw new Error(
          `POST ${KEY_ROUTES.saveKey} is unreachable — is the Next.js server running? ` +
            `Original error: ${err.message}`
        );
      }
    );
    expect(
      [200, 201].includes(res.status),
      `Expected 200 or 201 from POST ${KEY_ROUTES.saveKey} but got ${res.status}. ` +
        `The key-save endpoint must be implemented at this route.`
    ).toBe(true);
  });

  it("DB row anakin_key_ct is non-null after POST", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const ct = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      ct,
      `users.anakin_key_ct for user ${FIXTURE_USER_WITH_KEY.id} is null after POST ${KEY_ROUTES.saveKey}. ` +
        `The backend must AES-256-GCM encrypt the plaintext and persist the ciphertext ` +
        `(ADR-0001 §"Encryption key": nonce(12) || ciphertext || tag(16)).`
    ).not.toBeNull();
  });

  it("stored ciphertext has at least 29 bytes (nonce + tag minimum)", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const ct = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      ct!.length,
      `users.anakin_key_ct has ${ct!.length} bytes but must have at least ${MIN_CIPHERTEXT_BYTES} ` +
        `(nonce=12, tag=16, plus ≥1 byte ciphertext). ` +
        `ADR-0001: column layout is nonce(12) || ciphertext || tag(16).`
    ).toBeGreaterThanOrEqual(MIN_CIPHERTEXT_BYTES);
  });

  it("stored ciphertext does NOT contain the plaintext key substring", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const ct = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    const ctString = ct!.toString("utf8");
    const ctHex = ct!.toString("hex");
    const ctBase64 = ct!.toString("base64");

    const plaintextAppearsAsUtf8 = ctString.includes(VALID_FORMAT_KEY);
    const plaintextAppearsAsHex = ctHex.includes(
      Buffer.from(VALID_FORMAT_KEY).toString("hex")
    );
    const plaintextAppearsAsBase64 = ctBase64.includes(
      Buffer.from(VALID_FORMAT_KEY).toString("base64")
    );

    expect(
      plaintextAppearsAsUtf8 || plaintextAppearsAsHex || plaintextAppearsAsBase64,
      `The plaintext key "${VALID_FORMAT_KEY}" appears verbatim in the stored ciphertext ` +
        `(checked as UTF-8, hex, and base64). ` +
        `The backend MUST encrypt the key before storing it. ` +
        `ADR-0001: AES-256-GCM encryption required.`
    ).toBe(false);
  });

  it('anakin_key_status is "ok" after a successful POST', async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const status = getAnakinKeyStatus(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      status,
      `users.anakin_key_status is "${status}" but must be "ok" after a successful key save. ` +
        `ADR-0002: the status is updated to "ok" after the probe succeeds.`
    ).toBe("ok");
  });

  it("anakin_key_status_at is set (non-null) after a successful POST", async () => {
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    const statusAt = getAnakinKeyStatusAt(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      statusAt,
      `users.anakin_key_status_at is null after POST ${KEY_ROUTES.saveKey}. ` +
        `The backend must set anakin_key_status_at = now() alongside the status.`
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Invalid-format rejection (DoD item 6)
// ---------------------------------------------------------------------------

describe("Invalid-format rejection — POST /api/me/anakin-key", () => {
  beforeAll(async () => {
    if (!db) {
      dbPath = makeTempDbPath();
      runSeed(dbPath);
      db = await openTestDb(dbPath);
    }
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
    // Reset to avoid re-use across describe blocks when running sequentially
    db = undefined as any;
    dbPath = undefined as any;
  });

  it("POST with empty key returns 400", async () => {
    const res = await postAnakinKey(INVALID_KEYS.empty, FIXTURE_SESSION_TOKEN_A);
    expect(
      res.status,
      `POST ${KEY_ROUTES.saveKey} with empty key returned ${res.status} but must return 400. ` +
        `docs/design/auth-and-onboarding.md §4C: format-invalid triggers inline error, no server call. ` +
        `If validation is server-side, the endpoint must return 400.`
    ).toBe(400);
  });

  it("POST with whitespace-only key returns 400", async () => {
    const res = await postAnakinKey(INVALID_KEYS.whitespace, FIXTURE_SESSION_TOKEN_A);
    expect(
      res.status,
      `POST ${KEY_ROUTES.saveKey} with whitespace-only key returned ${res.status} but must return 400. ` +
        `docs/design/auth-and-onboarding.md §E2: strip whitespace, then validate; empty = invalid.`
    ).toBe(400);
  });

  it("POST with too-short key returns 400", async () => {
    const res = await postAnakinKey(INVALID_KEYS.tooShort, FIXTURE_SESSION_TOKEN_A);
    expect(
      res.status,
      `POST ${KEY_ROUTES.saveKey} with key "${INVALID_KEYS.tooShort}" (${INVALID_KEYS.tooShort.length} chars) ` +
        `returned ${res.status} but must return 400. ` +
        `ADR-0002: Anakin format minimum is 20 characters; this key is below that.`
    ).toBe(400);
  });

  it("400 response body contains the UX-spec'd format-invalid copy", async () => {
    const res = await postAnakinKey(INVALID_KEYS.empty, FIXTURE_SESSION_TOKEN_A);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;

    const bodyStr = JSON.stringify(body);
    expect(
      bodyStr.includes(ONBOARDING_COPY.errors.formatInvalid) ||
        (body.error as string ?? "").includes("valid Anakin API key") ||
        (body.message as string ?? "").includes("valid Anakin API key"),
      `400 response body does not contain the UX-spec'd format-invalid message. ` +
        `Expected (or a substring of): "${ONBOARDING_COPY.errors.formatInvalid}". ` +
        `Got: ${bodyStr.slice(0, 500)}. ` +
        `docs/design/auth-and-onboarding.md §5C locks this copy string.`
    ).toBe(true);
  });

  it("existing key is NOT clobbered by an invalid POST", async () => {
    // First, save a valid key so there is something to preserve.
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    const ctBefore = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(ctBefore, "Pre-condition: valid key must be saved before the invalid POST").not.toBeNull();

    // Now attempt to save an invalid key.
    await postAnakinKey(INVALID_KEYS.tooShort, FIXTURE_SESSION_TOKEN_A);

    const ctAfter = getAnakinKeyCt(db, FIXTURE_USER_WITH_KEY.id);
    expect(
      ctAfter,
      `users.anakin_key_ct became null after an invalid-format POST — the existing key was clobbered. ` +
        `The backend must reject invalid-format keys with 400 WITHOUT overwriting the stored ciphertext.`
    ).not.toBeNull();

    // The ciphertext bytes must be unchanged.
    expect(
      Buffer.compare(ctBefore!, ctAfter!),
      `users.anakin_key_ct changed after an invalid-format POST — the existing key was overwritten. ` +
        `The backend must reject invalid-format keys without touching the stored ciphertext.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Status enum integrity (DoD item 7)
// ---------------------------------------------------------------------------

describe("Status enum integrity — users.anakin_key_status", () => {
  let enumDbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let enumDb: any;

  beforeAll(async () => {
    enumDbPath = makeTempDbPath();
    runSeed(enumDbPath);
    enumDb = await openTestDb(enumDbPath);
  });

  afterAll(() => {
    if (enumDb) enumDb.close();
    if (enumDbPath && existsSync(enumDbPath)) unlinkSync(enumDbPath);
  });

  for (const validStatus of VALID_KEY_STATUSES) {
    it(`accepts valid status value: "${validStatus}"`, () => {
      // A direct DB write of a valid value must succeed.
      expect(() => {
        enumDb
          .prepare("UPDATE users SET anakin_key_status = ? WHERE id = ?")
          .run(validStatus, FIXTURE_USER_WITH_KEY.id);
      }).not.toThrow();

      const stored = getAnakinKeyStatus(enumDb, FIXTURE_USER_WITH_KEY.id);
      expect(stored).toBe(validStatus);
    });
  }

  it("rejects an arbitrary invalid status value at the schema level", () => {
    // The Drizzle schema must add a CHECK constraint (or SQLite text affinity +
    // generated column check) so that values outside the four documented
    // statuses are rejected at the DB level — not only in application code.
    //
    // If tryWriteInvalidStatus returns true, the write succeeded and the
    // constraint is absent — which is the expected Mode 1 failure.
    const succeeded = tryWriteInvalidStatus(
      enumDb,
      FIXTURE_USER_WITH_KEY.id,
      "this-is-not-a-valid-status"
    );
    expect(
      succeeded,
      `The DB accepted the invalid anakin_key_status value "this-is-not-a-valid-status". ` +
        `The schema must enforce a CHECK constraint so only the four documented values are allowed: ` +
        `${VALID_KEY_STATUSES.join(", ")}. ` +
        `ADR-0002 §"Error taxonomy": the enum is locked and must not drift.`
    ).toBe(false);
  });

  it("rejects an empty-string status value", () => {
    const succeeded = tryWriteInvalidStatus(
      enumDb,
      FIXTURE_USER_WITH_KEY.id,
      ""
    );
    expect(
      succeeded,
      `The DB accepted an empty-string anakin_key_status. ` +
        `The schema CHECK constraint must reject empty strings.`
    ).toBe(false);
  });

  it("rejects a null status value (column must be NOT NULL after first write)", () => {
    // NULL is separately controlled by the NOT NULL column constraint.
    // A user who has submitted a key must always have a non-null status.
    // This test writes null after the fixture key has been saved.
    let nullWriteSucceeded = false;
    try {
      enumDb
        .prepare("UPDATE users SET anakin_key_status = NULL WHERE id = ?")
        .run(FIXTURE_USER_WITH_KEY.id);
      const stored = getAnakinKeyStatus(enumDb, FIXTURE_USER_WITH_KEY.id);
      if (stored === null) nullWriteSucceeded = true;
    } catch {
      nullWriteSucceeded = false;
    }
    expect(
      nullWriteSucceeded,
      `The DB accepted NULL for anakin_key_status after a key has been saved. ` +
        `Once a key is stored, the status column must remain non-null ` +
        `(it is set to "ok" on save and updated to an error status if the probe fails).`
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: No-log assertion (DoD item 8)
// ---------------------------------------------------------------------------

describe("No-log assertion — plaintext key must not appear in logs", () => {
  let logDbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logDb: any;

  beforeAll(async () => {
    logDbPath = makeTempDbPath();
    runSeed(logDbPath);
    logDb = await openTestDb(logDbPath);
  });

  afterAll(() => {
    if (logDb) logDb.close();
    if (logDbPath && existsSync(logDbPath)) unlinkSync(logDbPath);
  });

  it("plaintext key does not appear in stdout/stderr during a key POST", async () => {
    startLogCapture();
    try {
      await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);
    } finally {
      const output = stopLogCapture();
      expect(
        output.includes(VALID_FORMAT_KEY),
        `The plaintext key "${VALID_FORMAT_KEY}" appeared in stdout/stderr during POST ${KEY_ROUTES.saveKey}. ` +
          `ADR-0002 §"Per-call credential injection": the plaintext key must never be logged. ` +
          `The Pino redact path must scrub ["headers.authorization", "*.apiKey", "*.api_key", "*.anakin_key"]. ` +
          `Captured output (first 1000 chars): ${output.slice(0, 1000)}`
      ).toBe(false);
    }
  });

  it("plaintext key does not appear in stdout/stderr during key rotation", async () => {
    // Save key 1
    await postAnakinKey(VALID_FORMAT_KEY, FIXTURE_SESSION_TOKEN_A);

    // Now rotate to key 2, capturing logs
    startLogCapture();
    try {
      await postAnakinKey(VALID_FORMAT_KEY_2, FIXTURE_SESSION_TOKEN_A);
    } finally {
      const output = stopLogCapture();
      expect(
        output.includes(VALID_FORMAT_KEY) || output.includes(VALID_FORMAT_KEY_2),
        `A plaintext key appeared in stdout/stderr during key rotation. ` +
          `ADR-0002: plaintext must never be logged. ` +
          `Captured output (first 1000 chars): ${output.slice(0, 1000)}`
      ).toBe(false);
    }
  });

  it("plaintext key does not appear in stdout/stderr when an invalid key is rejected", async () => {
    startLogCapture();
    try {
      await postAnakinKey(INVALID_KEYS.tooShort, FIXTURE_SESSION_TOKEN_A);
    } finally {
      const output = stopLogCapture();
      expect(
        output.includes(INVALID_KEYS.tooShort),
        `The rejected plaintext key "${INVALID_KEYS.tooShort}" appeared in stdout/stderr. ` +
          `Even on the error path, keys must not be logged. ` +
          `Captured output (first 1000 chars): ${output.slice(0, 1000)}`
      ).toBe(false);
    }
  });
});
