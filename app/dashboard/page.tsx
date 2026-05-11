import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db, rawQuery } from "../../db/client";
import { users, sessions, spreadSnapshots, questionMatches, spreadHistory } from "../../db/schema";
import { eq, and, gt, inArray } from "drizzle-orm";
import DashboardClient from "./DashboardClient";
import type { WatchedQuestion, Platform, SpreadHistoryPoint } from "./WatchedSection";

export const metadata: Metadata = {
  title: "Dashboard — ArbWatch",
};

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function getUserInfo(): Promise<{
  userId: string;
  email: string;
  keyStatus: string;
} | null> {
  const cookieStore = await cookies();
  const sessionToken =
    cookieStore.get(SESSION_COOKIE_NAME)?.value ??
    cookieStore.get("next-auth.session-token")?.value ??
    cookieStore.get("authjs.session-token")?.value;

  if (!sessionToken) return null;

  const now = new Date();
  const [result] = await db
    .select({
      userId: sessions.userId,
      email: users.email,
      keyStatus: users.anakinKeyStatus,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  if (!result) return null;
  return {
    userId: result.userId,
    email: result.email,
    keyStatus: result.keyStatus,
  };
}

async function getWatchedQuestions(userId: string): Promise<WatchedQuestion[]> {
  const rows = await rawQuery<{ id: string; query_text: string; created_at: number; threshold: number | null }>`SELECT id, query_text, created_at, threshold FROM watched_questions
       WHERE user_id = ${userId}
       ORDER BY created_at ASC`;

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86_400;

  const [snapshots, matches, historyRows] = await Promise.all([
    db
      .select({
        question_id: spreadSnapshots.questionId,
        spread: spreadSnapshots.spread,
        last_updated: spreadSnapshots.lastUpdated,
      })
      .from(spreadSnapshots)
      .where(inArray(spreadSnapshots.questionId, ids))
      .orderBy(spreadSnapshots.computedAt),
    db
      .select({
        question_id: questionMatches.questionId,
        platform: questionMatches.platform,
        market_id: questionMatches.marketId,
        market_url: questionMatches.marketUrl,
        market_title: questionMatches.marketTitle,
        implied_yes_prob: questionMatches.impliedYesProb,
        close_date: questionMatches.closeDate,
      })
      .from(questionMatches)
      .where(inArray(questionMatches.questionId, ids)),
    db
      .select({
        question_id: spreadHistory.questionId,
        spread: spreadHistory.spread,
        computed_at: spreadHistory.computedAt,
      })
      .from(spreadHistory)
      .where(and(inArray(spreadHistory.questionId, ids), gt(spreadHistory.computedAt, sevenDaysAgo)))
      .orderBy(spreadHistory.computedAt),
  ]);

  const snapshotMap = new Map<string, { spread: number | null; last_updated: number }>();
  for (const s of snapshots) {
    if (!snapshotMap.has(s.question_id)) {
      snapshotMap.set(s.question_id, {
        spread: s.spread,
        last_updated: s.last_updated,
      });
    }
  }

  const matchesMap = new Map<string, Array<{ platform: Platform; market_id: string; market_url: string | null; market_title: string | null; implied_yes_prob: number | null; close_date: string | null }>>();
  for (const m of matches) {
    const list = matchesMap.get(m.question_id) ?? [];
    list.push({ platform: m.platform, market_id: m.market_id, market_url: m.market_url, market_title: m.market_title, implied_yes_prob: m.implied_yes_prob, close_date: m.close_date ?? null });
    matchesMap.set(m.question_id, list);
  }

  const historyMap = new Map<string, SpreadHistoryPoint[]>();
  for (const h of historyRows) {
    const list = historyMap.get(h.question_id) ?? [];
    list.push({ spread: h.spread, computed_at: h.computed_at });
    historyMap.set(h.question_id, list);
  }

  return rows.map((r) => {
    const snapshot = snapshotMap.get(r.id);
    return {
      id: r.id,
      query_text: r.query_text,
      created_at: r.created_at,
      spread: snapshot?.spread ?? null,
      last_updated: snapshot?.last_updated ?? null,
      matches: matchesMap.get(r.id) ?? [],
      threshold: r.threshold ?? null,
      history: historyMap.get(r.id) ?? [],
    };
  });
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userInfo = await getUserInfo();

  if (!userInfo) {
    redirect("/signin");
  }

  // TODO: sync with ADR-0002 — error code strings defined there
  const keyStatus = userInfo.keyStatus;

  const params = await searchParams;
  const showWelcomeToast = params.welcome === "1";

  // Gate: key-missing users must complete onboarding first.
  // Exception: allow through on first arrival from onboarding (?welcome=1)
  // so the welcome toast and empty-state copy render immediately after the
  // first key save, before the background probe updates the status to "ok".
  if (keyStatus === "key-missing" && !showWelcomeToast) {
    redirect("/onboarding/key");
  }

  const initialQuestions = await getWatchedQuestions(userInfo.userId);

  return (
    <DashboardClient
      keyStatus={keyStatus as "ok" | "key-invalid" | "quota-exhausted" | "key-missing"}
      showWelcomeToast={showWelcomeToast}
      userEmail={userInfo.email}
      initialQuestions={initialQuestions}
    />
  );
}
