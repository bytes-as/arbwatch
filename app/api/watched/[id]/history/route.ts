/**
 * app/api/watched/[id]/history/route.ts
 *
 * GET /api/watched/:id/history
 *
 * Returns the spread history for the given watched question as
 * [{ spread, computed_at }, ...] sorted ASC by computed_at, capped to the
 * last 7 days.
 *
 * Auth-gated via session cookie. Scopes the question lookup to the session
 * user so a request for another user's question returns 404 (not 403) —
 * leaking nothing about row existence.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../../../db/client";
import { sessions, watchedQuestions } from "../../../../../db/schema";
import { eq, and, gt } from "drizzle-orm";

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
  const [result] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  return result ? { userId: result.userId } : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;

  const [row] = await db
    .select({ id: watchedQuestions.id })
    .from(watchedQuestions)
    .where(
      and(
        eq(watchedQuestions.id, id),
        eq(watchedQuestions.userId, session.userId)
      )
    );

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86_400;

  const rows = await rawQuery<{ spread: number | null; computed_at: number }>`SELECT spread, computed_at
       FROM spread_history
       WHERE question_id = ${id} AND computed_at >= ${sevenDaysAgo}
       ORDER BY computed_at ASC`;

  return NextResponse.json(rows);
}
