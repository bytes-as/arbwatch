/**
 * Mock for the Resend SDK.
 *
 * This module is loaded automatically by Vitest when
 * `vi.mock("resend")` is called. It replaces the real Resend SDK with an
 * in-memory inbox that tests can inspect.
 *
 * Usage in tests:
 *   import { getInbox, clearInbox } from "../__mocks__/resend"
 *   vi.mock("resend")
 */

export interface CapturedEmail {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  /** Raw options forwarded to Resend.emails.send */
  raw: Record<string, unknown>;
}

/** In-memory inbox shared across the test run. Reset between tests with clearInbox(). */
const inbox: CapturedEmail[] = [];

export function getInbox(): CapturedEmail[] {
  return inbox;
}

export function clearInbox(): void {
  inbox.length = 0;
}

/**
 * Return the most-recently captured email, throwing if the inbox is empty.
 * Useful for single-email tests: `const email = getLatestEmail()`.
 */
export function getLatestEmail(): CapturedEmail {
  if (inbox.length === 0) {
    throw new Error(
      "Resend mock inbox is empty — no email has been enqueued yet. " +
        "Did you forget to trigger the magic-link request?"
    );
  }
  return inbox[inbox.length - 1];
}

/**
 * Scan the inbox and return all token URLs found in email bodies.
 * A token URL matches the pattern: /auth/verify?token=<TOKEN> or
 * the NextAuth default callback URL with a token parameter.
 */
export function extractTokenUrls(email: CapturedEmail): string[] {
  const body = (email.html ?? email.text ?? "") + JSON.stringify(email.raw);
  // NextAuth v5 Email Provider sends a callbackUrl that includes a token param.
  // Match both /auth/verify?token=... and the NextAuth internal
  // /api/auth/callback/email?token=... pattern.
  const matches = body.match(
    /https?:\/\/[^\s"<>]+(?:token|callbackUrl|magic)[^\s"<>]*/gi
  );
  return matches ?? [];
}

// ---------------------------------------------------------------------------
// Vitest-compatible mock factory — replaces `import { Resend } from "resend"`
// ---------------------------------------------------------------------------

export class Resend {
  emails = {
    send: vi.fn(async (opts: Record<string, unknown>) => {
      const email: CapturedEmail = {
        from: (opts.from as string) ?? "",
        to: (opts.to as string | string[]) ?? "",
        subject: (opts.subject as string) ?? "",
        html: opts.html as string | undefined,
        text: opts.text as string | undefined,
        raw: opts,
      };
      inbox.push(email);
      return { data: { id: `mock-email-${inbox.length}` }, error: null };
    }),
  };
}

// Also export a default for `import Resend from "resend"` patterns
export default Resend;
