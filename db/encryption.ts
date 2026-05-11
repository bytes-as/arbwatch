import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Uint8Array {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY env var is not set");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32)
    throw new Error(
      `APP_ENCRYPTION_KEY must be 32 bytes (got ${bytes.length})`
    );
  if (
    process.env.NODE_ENV === "production" &&
    bytes.every((b) => b === 0)
  ) {
    throw new Error(
      "APP_ENCRYPTION_KEY is the all-zero placeholder; refusing to start in production. Generate a real 32-byte key and set it in your environment."
    );
  }
  return bytes;
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a Buffer with layout: nonce(12) || ciphertext || tag(16).
 * AAD binds the ciphertext to its row (use user.id as AAD per ADR-0001).
 */
export function encrypt(plaintext: string, aad: string): Buffer {
  const key = getKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = gcm(key, nonce, Buffer.from(aad));
  const cipherWithTag = cipher.encrypt(Buffer.from(plaintext, "utf8"));
  return Buffer.concat([nonce, cipherWithTag]);
}

/**
 * Decrypts a Buffer produced by encrypt().
 * Throws if authentication fails (wrong key, wrong AAD, or tampered ciphertext).
 */
export function decrypt(ciphertext: Buffer, aad: string): string {
  if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH + 1)
    throw new Error("Ciphertext is too short");
  const key = getKey();
  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const body = ciphertext.subarray(NONCE_LENGTH);
  const cipher = gcm(key, nonce, Buffer.from(aad));
  const plaintext = cipher.decrypt(body);
  return Buffer.from(plaintext).toString("utf8");
}
