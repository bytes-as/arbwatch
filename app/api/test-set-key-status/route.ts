/**
 * POST /api/test-set-key-status
 *
 * Test-only endpoint. Returns 404 when ENABLE_TEST_ROUTES !== "true".
 *
 * Accepts a JSON body:
 * { user_id: string, status: "ok" | "key-missing" | "key-invalid" | "quota-exhausted" }
 *
 * The session user must match user_id — attempts to mutate a different user
 * return 403 (or 401 if no session is present).
 *
 * <!-- TODO: sync with ADR-0002 — error code strings defined there -->
 */

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "../../../db/client";

type KeyStatus = "ok" | "key-missing" | "key-invalid" | "quota-exhausted";

const VALID_STATUSES: KeyStatus[] = [
  "ok",
  "key-missing",
  "key-invalid",
  "quota-exhausted",
];

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

function getSessionUserId(request: NextRequest): string | null {
  const sessionToken =
    request.cookies.get(SESSION_COOKIE_NAME)?.value ??
    request.cookies.get("next-auth.session-token")?.value ??
    request.cookies.get("authjs.session-token")?.value;

  if (!sessionToken) return null;

  const row = sqlite
    .prepare(
      "SELECT userId FROM sessions WHERE sessionToken = ? AND expires > ?"
    )
    .get(sessionToken, Date.now()) as { userId: string } | undefined;

  return row?.userId ?? null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.ENABLE_TEST_ROUTES !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sessionUserId = getSessionUserId(request);
  if (!sessionUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    user_id?: string;
    status?: string;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { user_id, status } = body;

  if (!user_id || typeof user_id !== "string") {
    return NextResponse.json(
      { error: "user_id is required and must be a string" },
      { status: 400 }
    );
  }

  if (sessionUserId !== user_id) {
    return NextResponse.json(
      { error: "Forbidden: session user does not match user_id" },
      { status: 403 }
    );
  }

  if (!status || !VALID_STATUSES.includes(status as KeyStatus)) {
    return NextResponse.json(
      {
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const result = sqlite
    .prepare(
      `UPDATE users SET anakin_key_status = ? WHERE id = ?`
    )
    .run(status, user_id);

  if (result.changes === 0) {
    return NextResponse.json(
      { error: `User ${user_id} not found` },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, user_id, status });
}
