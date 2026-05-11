/**
 * app/api/watched/[id]/route.ts
 *
 * DELETE /api/watched/:id — remove a watched question by id.
 *
 * Auth-gated. Lookup is scoped to WHERE id = :id AND user_id = session.userId
 * so that a request for another user's question returns 404 (not 403) —
 * leaking nothing about whether the row exists for a different user.
 *
 * Cascade: if the question_matches table exists, its rows for this question_id
 * are deleted first. If the table is absent (task-matching-impl not yet landed),
 * the cascade is skipped silently.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../../db/client";
import { sessions, watchedQuestions } from "../../../../db/schema";
import { eq, and, gt } from "drizzle-orm";

const THRESHOLD_MIN = 0.005;
const THRESHOLD_MAX = 0.10;

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
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

  // Cascade to question_matches if the table exists (task-matching-impl dependency).
  try {
    await rawQuery`DELETE FROM question_matches WHERE question_id = ${id}`;
  } catch {
    // Table does not exist yet — skip cascade silently.
  }

  await db
    .delete(watchedQuestions)
    .where(
      and(
        eq(watchedQuestions.id, id),
        eq(watchedQuestions.userId, session.userId)
      )
    );

  return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// PATCH — update per-question threshold
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  const rawThreshold = body.threshold;

  if (rawThreshold !== null && rawThreshold !== undefined) {
    if (typeof rawThreshold !== "number") {
      return NextResponse.json(
        { error: "threshold must be a number or null." },
        { status: 400 }
      );
    }
    if (rawThreshold < THRESHOLD_MIN || rawThreshold > THRESHOLD_MAX) {
      return NextResponse.json(
        { error: `threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}.` },
        { status: 400 }
      );
    }
  }

  const threshold: number | null =
    rawThreshold === null || rawThreshold === undefined
      ? null
      : (rawThreshold as number);

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

  await rawQuery`UPDATE watched_questions SET threshold = ${threshold} WHERE id = ${id} AND user_id = ${session.userId}`;

  const updatedRows = await rawQuery<{ id: string; query_text: string; created_at: number; threshold: number | null }>`SELECT id, query_text, created_at, threshold FROM watched_questions WHERE id = ${id}`;
  const updated = updatedRows[0];

  return NextResponse.json(updated, { status: 200 });
}
