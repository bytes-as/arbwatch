import { NextResponse } from "next/server";

// This endpoint only works in test mode and is used by Playwright tests
// to retrieve the latest magic-link URL captured by the Resend mock.
export async function GET() {
  if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The mock inbox is managed by the vitest mock at tests/auth/__mocks__/resend.ts
  // In the test environment, we read from a shared module-level store.
  // For Playwright tests, the server runs in a separate process, so we use
  // an in-memory store that the NextAuth Email Provider populates via the
  // global test inbox.
  const inbox = (global as any).__testResendInbox as Array<{
    to: string | string[];
    html?: string;
    text?: string;
  }> | undefined;

  if (!inbox || inbox.length === 0) {
    return NextResponse.json(
      { error: "No emails in test inbox" },
      { status: 404 }
    );
  }

  const latest = inbox[inbox.length - 1];
  const body = (latest.html ?? latest.text ?? "") as string;

  // Extract the token URL from the email body
  const matches = body.match(
    /https?:\/\/[^\s"<>]+(?:token|callbackUrl|magic)[^\s"<>]*/gi
  );
  const tokenUrl = matches?.[0] ?? null;

  return NextResponse.json({
    tokenUrl,
    url: tokenUrl,
    magicLinkUrl: tokenUrl,
    to: latest.to,
    html: latest.html,
    text: latest.text,
  });
}
