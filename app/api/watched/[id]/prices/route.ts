/**
 * GET /api/watched/:id/prices
 *
 * Fetches live price + metadata (volume, close date) for all matched markets
 * on a watched question. Auth-gated and scoped to the requesting user only.
 *
 * Calls the Wire detail action for each platform in parallel. Returns as soon
 * as all settle (or timeout). The UI shows cached prices immediately and
 * replaces with fresh values when this resolves.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, rawQuery } from "../../../../../db/client";
import { sessions } from "../../../../../db/schema";
import { eq, and, gt } from "drizzle-orm";
import { wireRequest } from "../../../../../lib/wire/client";
import {
  extractImpliedYesProb,
  extractCloseDate,
  extractVolume,
} from "../../../../../lib/wire/mapping";

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function resolveSession(req: NextRequest): Promise<{ userId: string } | null> {
  const token =
    req.cookies.get(SESSION_COOKIE_NAME)?.value ??
    req.cookies.get("next-auth.session-token")?.value ??
    req.cookies.get("authjs.session-token")?.value;
  if (!token) return null;
  const now = new Date();
  const row = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, token), gt(sessions.expires, now)))
    .get();
  return row ? { userId: row.userId } : null;
}

const DETAIL_ACTION: Record<string, string> = {
  kalshi: "kl_market_detail",
  manifold: "mm_market_prob",
  polymarket: "pm_get_market",
  robinhood: "rh_get_event",
};

function detailParams(platform: string, marketId: string): Record<string, unknown> {
  if (platform === "kalshi") return { ticker: marketId };
  if (platform === "manifold") return { market_id: marketId };
  if (platform === "polymarket") return { market_id: marketId };
  if (platform === "robinhood") return { event_id: marketId };
  return {};
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const matches = await rawQuery<{ platform: string; market_id: string }>`SELECT qm.platform, qm.market_id
       FROM question_matches qm
       JOIN watched_questions wq ON wq.id = qm.question_id
       WHERE qm.question_id = ${id} AND wq.user_id = ${session.userId}`;

  if (matches.length === 0) return NextResponse.json({ prices: [] });

  const settled = await Promise.allSettled(
    matches.map(async ({ platform, market_id }) => {
      const action = DETAIL_ACTION[platform];
      if (!action) return null;
      const payload = await wireRequest(
        session.userId,
        action,
        detailParams(platform, market_id)
      );
      return { platform, market_id, payload };
    })
  );

  const prices = settled.map((result, i) => {
    const { platform, market_id } = matches[i];
    if (result.status === "rejected" || result.value === null) {
      return { platform, market_id, implied_yes_prob: null, close_date: null, volume: null };
    }
    const { payload } = result.value;
    return {
      platform,
      market_id,
      implied_yes_prob: extractImpliedYesProb(platform, payload),
      close_date: extractCloseDate(platform, payload),
      volume: extractVolume(platform, payload),
    };
  });

  // Persist fresh prices back to DB
  for (const p of prices) {
    if (p.implied_yes_prob !== null || p.close_date !== null) {
      await rawQuery`UPDATE question_matches SET implied_yes_prob = COALESCE(${p.implied_yes_prob}, implied_yes_prob), close_date = COALESCE(${p.close_date}, close_date) WHERE question_id = ${id} AND platform = ${p.platform}`;
    }
  }

  return NextResponse.json({ prices });
}
