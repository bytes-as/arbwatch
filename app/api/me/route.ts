import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../db/client";
import { users, sessions } from "../../../db/schema";
import { eq, and, gt } from "drizzle-orm";

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

export async function GET(request: NextRequest) {
  // Read the session token from the request cookies directly.
  // This works in both Next.js App Router context and in-process Vitest tests.
  const sessionToken =
    request.cookies.get(SESSION_COOKIE_NAME)?.value ??
    request.cookies.get("next-auth.session-token")?.value ??
    request.cookies.get("authjs.session-token")?.value;

  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const result = await db
    .select({
      id: users.id,
      email: users.email,
      anakin_key_status: users.anakinKeyStatus,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.sessionToken, sessionToken),
        gt(sessions.expires, now)
      )
    )
    .get();

  if (!result) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    id: result.id,
    email: result.email,
    anakin_key_status: result.anakin_key_status,
  });
}
