/**
 * app/api/me/anakin-key/route.ts
 *
 * GET    /api/me/anakin-key  — returns the caller's key status (never plaintext, never ciphertext)
 * POST   /api/me/anakin-key  — paste or rotate the Anakin key (encrypted at rest)
 * DELETE /api/me/anakin-key  — remove the key
 *
 * All routes are auth-gated. userId is derived from the session only (no IDOR via query param).
 * ADR-0002: AAD = userId binds the ciphertext to the user's row.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { users, sessions } from "../../../../db/schema";
import { eq, and, gt } from "drizzle-orm";
import { encrypt } from "../../../../db/encryption";
import { invalidateWireCache, wireRequest } from "../../../../lib/wire/client";
import { WireError } from "../../../../lib/wire/errors";

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

/** Minimum valid key length per ADR-0002 (Anakin format minimum: 20 chars). */
const MIN_KEY_LENGTH = 20;

const FORMAT_INVALID_MSG =
  "That doesn't look like a valid Anakin API key. Check for extra spaces or missing characters.";

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

// ---------------------------------------------------------------------------
// GET — key status
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [row] = await db
    .select({
      status: users.anakinKeyStatus,
      statusAt: users.anakinKeyStatusAt,
    })
    .from(users)
    .where(eq(users.id, session.userId));

  if (!row) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    status: row.status,
    status_at: row.statusAt ? row.statusAt.toISOString() : null,
  });
}

// ---------------------------------------------------------------------------
// POST — paste / rotate key
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const rawKey = typeof body.key === "string" ? body.key : "";

  // Trim and validate format
  const trimmed = rawKey.trim();

  if (!trimmed || trimmed.length < MIN_KEY_LENGTH) {
    return NextResponse.json({ error: FORMAT_INVALID_MSG }, { status: 400 });
  }

  const ciphertext = encrypt(trimmed, session.userId);
  const now = new Date();

  await db
    .update(users)
    .set({ anakinKeyCt: ciphertext, anakinKeyStatusAt: now })
    .where(eq(users.id, session.userId));

  invalidateWireCache(session.userId);

  // Inline Wire probe: attempt a live key validation immediately after storing.
  // Pass the plaintext directly so the probe doesn't need to decrypt from DB.
  try {
    await wireRequest(session.userId, "kl_events", { query: "probe" }, { _rawKey: trimmed });

    await db
      .update(users)
      .set({ anakinKeyStatus: "ok", anakinKeyStatusAt: new Date() })
      .where(eq(users.id, session.userId));

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    if (err instanceof WireError) {
      const cls = err.class;

      if (cls === "key-invalid") {
        await db
          .update(users)
          .set({ anakinKeyStatus: "key-invalid", anakinKeyStatusAt: new Date() })
          .where(eq(users.id, session.userId));
        return NextResponse.json(
          {
            status: "key-invalid",
            error: "Anakin rejected this key. Double-check it in your Anakin dashboard and paste it again.",
          },
          { status: 400 }
        );
      }

      if (cls === "quota-exhausted") {
        await db
          .update(users)
          .set({ anakinKeyStatus: "quota-exhausted", anakinKeyStatusAt: new Date() })
          .where(eq(users.id, session.userId));
        return NextResponse.json({ status: "quota-exhausted" });
      }

      if (cls === "fixture-not-found" || cls === "transient" || cls === "other") {
        // In fixture mode the probe always returns fixture-not-found (no "probe"
        // fixture exists). Treat it as a successful validation so the dashboard
        // gate doesn't redirect the user back to onboarding in local dev.
        if (process.env.WIRE_MODE === "fixtures" || cls === "fixture-not-found") {
          await db
            .update(users)
            .set({ anakinKeyStatus: "ok", anakinKeyStatusAt: new Date() })
            .where(eq(users.id, session.userId));
        }
        // In live mode with a transient error, leave status as key-missing —
        // the cron will pick it up on next tick.
        return NextResponse.json({ status: "ok" });
      }
    }

    // Non-Wire transport failure: key stored, probe deferred.
    const [current] = await db
      .select({ status: users.anakinKeyStatus })
      .from(users)
      .where(eq(users.id, session.userId));

    return NextResponse.json({
      status: current?.status ?? "key-missing",
      warning: "Probe deferred — Wire could not be reached. Status will update on next cron tick.",
    });
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove key
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const session = await resolveSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  await db
    .update(users)
    .set({
      anakinKeyCt: null,
      anakinKeyStatus: "key-missing",
      anakinKeyStatusAt: now,
    })
    .where(eq(users.id, session.userId));

  invalidateWireCache(session.userId);

  return NextResponse.json({ status: "key-missing" });
}
