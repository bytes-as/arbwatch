/**
 * lib/wire/fixtures.ts
 *
 * Fixture file loader for WIRE_MODE=fixtures (ADR-0002 §"Local-dev fixture mode").
 *
 * Loads JSON from tests/fixtures/wire/<action>/<slug>.json.
 * Falls back to __default__.json when no slug-specific file exists.
 * Throws WireError({ class: "fixture-not-found" }) if neither exists.
 *
 * recordWireCall / getLastWireCall are used by tests (NODE_ENV=test) to
 * observe the auth header the Wire wrapper would have sent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WireError } from "./errors";

const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures", "wire");

/** Slug a query string into a filename-safe kebab-case token. */
function slugify(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function loadFixture(action: string, query: string): unknown {
  const slug = slugify(query);
  const specific = join(FIXTURES_DIR, action, `${slug}.json`);
  const fallback = join(FIXTURES_DIR, action, "__default__.json");

  if (existsSync(specific)) {
    return JSON.parse(readFileSync(specific, "utf8"));
  }
  if (existsSync(fallback)) {
    return JSON.parse(readFileSync(fallback, "utf8"));
  }

  throw new WireError({
    class: "fixture-not-found",
    message: `No fixture for action=${action} query="${query}" (checked ${specific} and ${fallback})`,
  });
}

// ---------------------------------------------------------------------------
// Test-only observation singleton
// ---------------------------------------------------------------------------

interface WireCallRecord {
  action: string;
  authHeader: string;
}

const _records: WireCallRecord[] = [];

/**
 * Called by the Wire wrapper when WIRE_MODE=fixtures so tests can observe
 * the auth header that would have been sent to Wire.
 */
export function recordWireCall(record: WireCallRecord): void {
  _records.push(record);
}

/** Returns and clears the last recorded Wire call. */
export function getLastWireCall(): WireCallRecord | undefined {
  return _records[_records.length - 1];
}

/** Clears all recorded Wire calls. */
export function clearWireCalls(): void {
  _records.length = 0;
}
