"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db, rawQuery } from "../../db/client";
import { sessions, watchedQuestions } from "../../db/schema";
import { eq, and, gt, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUERY_TEXT_LENGTH = 280;
const QUESTION_CAP = 5;
const CAP_EXCEEDED_MESSAGE =
  "You've reached the 5-question limit. Remove a question to add a new one.";

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

async function resolveSession(): Promise<{ userId: string } | null> {
  const cookieStore = await cookies();
  const sessionToken =
    cookieStore.get(SESSION_COOKIE_NAME)?.value ??
    cookieStore.get("next-auth.session-token")?.value ??
    cookieStore.get("authjs.session-token")?.value;

  if (!sessionToken) return null;

  const now = new Date();
  const [result] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  return result ? { userId: result.userId } : null;
}

// ---------------------------------------------------------------------------
// Add watched question (Server Action)
// ---------------------------------------------------------------------------

export async function addWatchedQuestionAction(
  _prevState: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | null> {
  const session = await resolveSession();
  if (!session) {
    redirect("/signin");
  }

  const raw = formData.get("query_text");
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  if (!trimmed) {
    return { error: "Please enter a question." };
  }

  if (trimmed.length > MAX_QUERY_TEXT_LENGTH) {
    return { error: `Question must be ${MAX_QUERY_TEXT_LENGTH} characters or fewer.` };
  }

  const [countResult] = await db
    .select({ cnt: count() })
    .from(watchedQuestions)
    .where(eq(watchedQuestions.userId, session.userId));

  const existing = countResult?.cnt ?? 0;
  if (existing >= QUESTION_CAP) {
    return { error: CAP_EXCEEDED_MESSAGE };
  }

  const id = randomUUID();
  const createdAt = Date.now();

  await rawQuery`INSERT INTO watched_questions (id, user_id, query_text, created_at) VALUES (${id}, ${session.userId}, ${trimmed}, ${createdAt})`;

  redirect("/dashboard");
}

// ---------------------------------------------------------------------------
// Remove watched question (Server Action)
// ---------------------------------------------------------------------------

export async function removeWatchedQuestionAction(
  formData: FormData
): Promise<void> {
  const session = await resolveSession();
  if (!session) {
    redirect("/signin");
  }

  const id = formData.get("question_id");
  if (typeof id !== "string" || !id) return;

  const [row] = await db
    .select({ id: watchedQuestions.id })
    .from(watchedQuestions)
    .where(
      and(
        eq(watchedQuestions.id, id),
        eq(watchedQuestions.userId, session.userId)
      )
    );

  if (!row) return;

  try {
    await rawQuery`DELETE FROM question_matches WHERE question_id = ${id}`;
  } catch {
    // Table does not exist yet
  }

  await db
    .delete(watchedQuestions)
    .where(
      and(
        eq(watchedQuestions.id, id),
        eq(watchedQuestions.userId, session.userId)
      )
    );

  redirect("/dashboard");
}
