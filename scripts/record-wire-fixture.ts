/**
 * scripts/record-wire-fixture.ts
 *
 * Records a Wire fixture file from a live API call.
 * Per ADR-0002 §"Local-dev fixture mode" and §"Per-call credential injection".
 *
 * Usage:
 *   WIRE_MODE=live ANAKIN_API_KEY=ak_... bun run scripts/record-wire-fixture.ts \
 *     --action kl_events \
 *     --query "will trump win 2028"
 *
 * The script:
 *   1. Calls Wire with the provided key and query.
 *   2. Redacts all auth-sensitive fields from the response JSON before writing.
 *      Redact paths (per ADR-0002 §"Per-call credential injection"):
 *        - headers.authorization
 *        - *.apiKey
 *        - *.api_key
 *        - *.anakin_key
 *   3. Writes the redacted JSON to:
 *        tests/fixtures/wire/<action>/<query-slug>.json
 *
 * In Sprint 3 this script does not need to be exercised against live Wire.
 * Its existence satisfies the architect's Sprint 3 follow-up (ADR-0002 §Follow-up 3).
 *
 * Requirements:
 *   - WIRE_MODE must be "live" (script refuses to run in fixtures mode to avoid
 *     accidentally overwriting a committed fixture with empty/default data).
 *   - ANAKIN_API_KEY must be set in the environment (or .env.local).
 *   - The output file is committed to the repo. CI and preview.sh will use it
 *     without any live credentials.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { action: string; query: string } {
  const args = argv.slice(2);
  let action: string | undefined;
  let query: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--action" && args[i + 1]) {
      action = args[++i];
    } else if (args[i] === "--query" && args[i + 1]) {
      query = args[++i];
    }
  }

  if (!action) {
    throw new Error(
      'Missing --action argument. Valid values: kl_events | mm_search_markets | pm_get_events | rh_get_events'
    );
  }

  const validActions = ["kl_events", "mm_search_markets", "pm_get_events", "rh_get_events"];
  if (!validActions.includes(action)) {
    throw new Error(
      `Invalid --action "${action}". Valid values: ${validActions.join(" | ")}`
    );
  }

  if (!query) {
    throw new Error('Missing --query argument. Example: --query "will trump win 2028"');
  }

  return { action, query };
}

// ---------------------------------------------------------------------------
// Slugify (mirrors lib/wire/fixtures.ts)
// ---------------------------------------------------------------------------

function slugify(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Deep-redact auth-sensitive fields from a JSON object.
// Redact paths per ADR-0002: headers.authorization, *.apiKey, *.api_key, *.anakin_key
// The value is replaced with "[REDACTED]" so consumers can detect redaction.
// ---------------------------------------------------------------------------

const REDACT_KEYS = new Set(["apiKey", "api_key", "anakin_key", "authorization"]);

function redact(value: unknown, parentKey?: string): unknown {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (REDACT_KEYS.has(k) || REDACT_KEYS.has(keyLower)) {
      result[k] = "[REDACTED]";
    } else if (k === "headers" && typeof v === "object" && v !== null) {
      // Redact headers.authorization specifically
      const headers = v as Record<string, unknown>;
      const redactedHeaders: Record<string, unknown> = {};
      for (const [hk, hv] of Object.entries(headers)) {
        if (hk.toLowerCase() === "authorization") {
          redactedHeaders[hk] = "[REDACTED]";
        } else {
          redactedHeaders[hk] = hv;
        }
      }
      result[k] = redactedHeaders;
    } else {
      result[k] = redact(v, k);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Wire call
// ---------------------------------------------------------------------------

const WIRE_BASE_URL = "https://wire.anakin.company/v1";

async function callWire(
  action: string,
  query: string,
  apiKey: string
): Promise<unknown> {
  const url = `${WIRE_BASE_URL}/actions/${action}`;
  const body = JSON.stringify({ query });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(
      `Wire call failed: HTTP ${res.status} ${res.statusText}\nBody: ${text}`
    );
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const wireMode = process.env.WIRE_MODE ?? "live";

  if (wireMode !== "live") {
    throw new Error(
      `WIRE_MODE is "${wireMode}" but must be "live" to record fixtures.\n` +
        `Set WIRE_MODE=live in your environment or .env.local.`
    );
  }

  const apiKey = process.env.ANAKIN_API_KEY;
  if (!apiKey) {
    throw new Error(
      `ANAKIN_API_KEY is not set.\n` +
        `Set it in .env.local (never commit the real key).\n` +
        `Example: ANAKIN_API_KEY=ak_your_key_here`
    );
  }

  const { action, query } = parseArgs(process.argv);
  const slug = slugify(query);

  console.log(`Recording Wire fixture:`);
  console.log(`  action: ${action}`);
  console.log(`  query:  "${query}"`);
  console.log(`  slug:   ${slug}`);
  console.log(`  url:    ${WIRE_BASE_URL}/actions/${action}`);
  console.log();

  console.log("Calling Wire...");
  const rawResponse = await callWire(action, query, apiKey);

  // Redact auth-sensitive fields before writing
  const redactedResponse = redact(rawResponse);

  // Add fixture metadata
  const fixture = {
    _fixture_meta: {
      action,
      query,
      slug,
      recorded: new Date().toISOString(),
      note: "Recorded via scripts/record-wire-fixture.ts. Auth headers redacted.",
    },
    ...(redactedResponse as Record<string, unknown>),
  };

  const REPO_ROOT = join(__dirname, "..");
  const fixtureDir = join(REPO_ROOT, "tests", "fixtures", "wire", action);
  const fixturePath = join(fixtureDir, `${slug}.json`);

  if (!existsSync(fixtureDir)) {
    mkdirSync(fixtureDir, { recursive: true });
  }

  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n", "utf8");

  console.log(`Fixture written to: ${fixturePath}`);
  console.log();
  console.log("Next step: commit this file so CI and preview.sh can use it.");
  console.log("The raw Anakin key is NOT stored in the fixture file.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
