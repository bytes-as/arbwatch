/**
 * lib/wire/decrypt.ts
 *
 * Per-user decryption helpers for the Wire client (ADR-0002).
 *
 * getDecryptedAnakinKey(userId) — reads the encrypted ciphertext from DB,
 * decrypts it in-place, and returns the plaintext scoped to the caller's frame.
 * The plaintext is never logged, never returned to callers as a persistent value.
 *
 * decryptAESGCM({ ct, aad, key }) — exported for test AAD-mismatch assertion.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { WireError } from "./errors";

const NONCE_LENGTH = 12;

/**
 * Low-level AES-256-GCM decrypt.
 * Exported so tests can assert that AAD mismatch throws.
 *
 * @param ct  - Buffer with layout nonce(12) || ciphertext || tag(16)
 * @param aad - Additional authenticated data (user.id)
 * @param key - Base64-encoded 32-byte key
 */
export function decryptAESGCM({
  ct,
  aad,
  key,
}: {
  ct: Buffer;
  aad: string;
  key: string;
}): string {
  const keyBytes = Buffer.from(key, "base64");
  if (keyBytes.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes (got ${keyBytes.length})`);
  }
  const nonce = ct.subarray(0, NONCE_LENGTH);
  const body = ct.subarray(NONCE_LENGTH);
  const cipher = gcm(keyBytes, nonce, Buffer.from(aad));
  const plaintext = cipher.decrypt(body);
  return Buffer.from(plaintext).toString("utf8");
}

/**
 * Retrieve and decrypt the Anakin key for a given user.
 * Throws WireError with the appropriate class if the key is unavailable.
 * The returned string is scoped to the call frame — never store it.
 */
export async function getDecryptedAnakinKey(userId: string): Promise<string> {
  const [row] = await db
    .select({
      anakinKeyCt: users.anakinKeyCt,
      anakinKeyStatus: users.anakinKeyStatus,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!row) {
    throw new WireError({ class: "key-missing" });
  }

  const status = row.anakinKeyStatus;

  // If no ciphertext is stored, the key is definitively missing.
  // A stored ciphertext with status=key-missing is a pending-validation state
  // (the key was saved but the probe has not yet confirmed it), so we allow
  // decryption and let the Wire call attempt succeed or fail on its own merits.
  if (!row.anakinKeyCt) {
    throw new WireError({ class: "key-missing" });
  }

  if (status === "key-invalid") {
    throw new WireError({ class: "key-invalid" });
  }

  if (status === "quota-exhausted") {
    throw new WireError({ class: "quota-exhausted" });
  }

  const rawKey = process.env.APP_ENCRYPTION_KEY;
  if (!rawKey) throw new Error("APP_ENCRYPTION_KEY env var is not set");

  return decryptAESGCM({
    ct: row.anakinKeyCt as Buffer,
    aad: userId,
    key: rawKey,
  });
}
