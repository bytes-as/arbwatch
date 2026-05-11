import { NextResponse } from "next/server";

// This endpoint only works in test/development mode and is used by Playwright
// tests to retrieve the latest magic-link URL captured by the Resend mock.
// Accessible at /api/test-inbox/latest directly; also reachable at
// /__test/mock-inbox/latest via the Next.js rewrite in next.config.ts.
export async function GET() {
  if (
    process.env.NODE_ENV !== "test" &&
    process.env.NODE_ENV !== "development"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const inbox = (global as any).__testResendInbox as
    | Array<{
        to: string | string[];
        html?: string;
        text?: string;
      }>
    | undefined;

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
