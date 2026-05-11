/**
 * lib/wire/client.ts
 *
 * Wire client per ADR-0002.
 *
 * Live mode uses the Anakin Holocron async task API:
 *   1. POST /holocron/task → {job_id, status: "processing"}
 *   2. Poll GET /holocron/jobs/{job_id} until status="completed"|"failed" or timeout.
 *
 * Exported callers: klEvents, mmSearchMarkets, pmSearchMarkets, rhGetMarkets,
 * and the underlying wireRequest for internal use.
 */

import { getDecryptedAnakinKey } from "./decrypt";
import { WireError } from "./errors";
import { loadFixture, recordWireCall } from "./fixtures";

const WIRE_BASE_URL = process.env.WIRE_BASE_URL ?? "https://api.anakin.io/v1";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 15; // 30s max

/** In-process cache keyed by userId. Invalidated on key paste/rotate/remove. */
const _clientCache = new Map<string, { cipherDigest: string }>();

export function invalidateWireCache(userId: string): void {
  _clientCache.delete(userId);
}

export function invalidateAllWireCache(): void {
  _clientCache.clear();
}

type WireAction = string;

/**
 * Perform a Wire call for the given user.
 * Decrypts the key on-demand; plaintext never leaves this function scope.
 */
export async function wireRequest(
  userId: string,
  action: WireAction,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; _rawKey?: string }
): Promise<unknown> {
  const wireMode = process.env.WIRE_MODE ?? "live";

  let plaintext: string;
  try {
    plaintext = options?._rawKey ?? (await getDecryptedAnakinKey(userId));
  } catch (err) {
    if (wireMode === "fixtures") {
      recordWireCall({ action, authHeader: "" });
    }
    throw err;
  }
  const authHeader = `Bearer ${plaintext}`;

  if (wireMode === "fixtures") {
    const query =
      (params.term as string) ??
      (params.search as string) ??
      (params.query as string) ??
      "";
    recordWireCall({ action, authHeader });
    return loadFixture(action, query);
  }

  // live mode — submit task then poll for result
  const submitUrl = `${WIRE_BASE_URL}/holocron/task`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };

  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ action_id: action, params }),
    signal: options?.signal,
  });

  if (submitRes.status === 401 || submitRes.status === 403) {
    throw new WireError({ class: "key-invalid" });
  }
  if (submitRes.status === 402) {
    throw new WireError({ class: "quota-exhausted" });
  }
  if (!submitRes.ok) {
    throw new WireError({ class: "transient" });
  }

  const submitBody = (await submitRes.json()) as { job_id: string; status: string };
  const jobId = submitBody.job_id;

  const pollUrl = `${WIRE_BASE_URL}/holocron/jobs/${jobId}`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(POLL_INTERVAL_MS);
    }

    const pollRes = await fetch(pollUrl, {
      method: "GET",
      headers: { Authorization: authHeader },
      signal: options?.signal,
    });

    if (pollRes.status === 401 || pollRes.status === 403) {
      throw new WireError({ class: "key-invalid" });
    }
    if (pollRes.status === 402) {
      throw new WireError({ class: "quota-exhausted" });
    }
    if (!pollRes.ok) {
      throw new WireError({ class: "transient" });
    }

    const pollBody = (await pollRes.json()) as {
      status: "completed" | "processing" | "failed";
      data?: unknown;
    };

    if (pollBody.status === "completed") {
      return pollBody.data;
    }
    if (pollBody.status === "failed") {
      throw new WireError({ class: "transient" });
    }
    // status === "processing" → continue polling
  }

  throw new WireError({ class: "transient" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Typed action callers
// ---------------------------------------------------------------------------

export async function klEvents(
  userId: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  return wireRequest(userId, "kl_events", params, options);
}

export async function mmSearchMarkets(
  userId: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  return wireRequest(userId, "mm_search_markets", params, options);
}

export async function pmSearchMarkets(
  userId: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  return wireRequest(userId, "pm_search_markets", params, options);
}

export async function rhGetMarkets(
  userId: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  return wireRequest(userId, "rh_get_markets", params, options);
}
