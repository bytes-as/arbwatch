/**
 * app/api/me/anakin-key/probe/route.ts
 *
 * POST /api/me/anakin-key/probe
 *
 * Triggers a Wire call using the authenticated user's key.
 * In WIRE_MODE=fixtures the Wire wrapper records the auth header it would have
 * sent; this endpoint echoes it back when X-Test-Observe-Auth-Header=true is
 * present (NODE_ENV=test only).
 *
 * Response shapes:
 *   - 200 { observedAuthHeader: string }  — wire call observed (fixture mode + test header)
 *   - 200 { status: "ok" }               — wire call completed (non-test mode)
 *   - 400 { error: "key-missing" | ... } — wire error before HTTP
 *   - 401                                — unauthenticated
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { sessions } from "../../../../../db/tables";
import { eq, and, gt } from "drizzle-orm";
import { wireRequest } from "../../../../../lib/wire/client";
import { getLastWireCall, clearWireCalls } from "../../../../../lib/wire/fixtures";
import { WireError } from "../../../../../lib/wire/errors";

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

  if (!result) return null;
  return { userId: result.userId };
}

export async function POST(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const observeHeader =
    request.headers.get("X-Test-Observe-Auth-Header") === "true" &&
    process.env.NODE_ENV === "test";

  if (observeHeader) {
    clearWireCalls();
  }

  try {
    await wireRequest(session.userId, "kl_events", { query: "probe" });
  } catch (err) {
    if (err instanceof WireError) {
      const cls = err.class;
      if (
        cls === "key-missing" ||
        cls === "key-invalid" ||
        cls === "quota-exhausted"
      ) {
        return NextResponse.json(
          { error: cls, errorTag: cls, code: cls },
          { status: 400 }
        );
      }
      if (cls === "fixture-not-found") {
        // fixture mode: no fixture for "probe" query — that's fine for test observation
        // The auth header was already recorded before the fixture lookup
        if (observeHeader) {
          const last = getLastWireCall();
          if (last) {
            return NextResponse.json({ observedAuthHeader: last.authHeader });
          }
        }
        return NextResponse.json({ status: "ok" });
      }
    }
    throw err;
  }

  if (observeHeader) {
    const last = getLastWireCall();
    if (last) {
      return NextResponse.json({ observedAuthHeader: last.authHeader });
    }
  }

  return NextResponse.json({ status: "ok" });
}
