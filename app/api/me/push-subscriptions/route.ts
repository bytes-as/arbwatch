/**
 * app/api/me/push-subscriptions/route.ts
 *
 * POST   /api/me/push-subscriptions — register a push subscription for the authenticated user
 * DELETE /api/me/push-subscriptions — remove a push subscription by endpoint
 *
 * Auth-gated via session cookie. User ID is always derived from the session.
 *
 * POST body: { endpoint: string; p256dh: string; auth: string }
 * DELETE body: { endpoint: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../../db/client";
import { sessions } from "../../../../db/schema";
import { eq, and, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function resolveSession(
  request: NextRequest
): Promise<{ userId: string } | null> {
  const sessionToken =
    request.cookies.get(SESSION_COOKIE_NAME)?.value ??
    request.cookies.get("next-auth.session-token")?.value ??
    request.cookies.get("authjs.session-token")?.value;

  if (!sessionToken) return null;

  const now = new Date();
  const result = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)))
    .get();

  return result ? { userId: result.userId } : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    endpoint?: string;
    p256dh?: string;
    auth?: string;
  } | null;

  if (
    !body ||
    typeof body.endpoint !== "string" ||
    typeof body.p256dh !== "string" ||
    typeof body.auth !== "string"
  ) {
    return NextResponse.json(
      { error: "Invalid body: expected { endpoint, p256dh, auth }" },
      { status: 400 }
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const psId = randomUUID();
  await rawQuery`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (${psId}, ${session.userId}, ${body.endpoint}, ${body.p256dh}, ${body.auth}, ${nowSec})
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         created_at = excluded.created_at`;

  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    endpoint?: string;
  } | null;

  if (!body || typeof body.endpoint !== "string") {
    return NextResponse.json(
      { error: "Invalid body: expected { endpoint }" },
      { status: 400 }
    );
  }

  await rawQuery`DELETE FROM push_subscriptions WHERE user_id = ${session.userId} AND endpoint = ${body.endpoint}`;

  return new NextResponse(null, { status: 204 });
}
