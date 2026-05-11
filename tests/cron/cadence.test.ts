// tests/cron/cadence.test.ts
//
// Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
//   - vercel.json exists at the repo root with a cron entry for
//     /api/cron/refresh-spreads at schedule "star/5 star star star star" (or finer).
//
// DoD item 1 — Cadence registration:
//   "Read vercel.json (or whatever ADR-0001 pins for cron config); assert the
//   cron entry for /api/cron/refresh-spreads is registered at an interval ≤5
//   minutes (cron expression every-5-min or finer)."
//
// Architecture reference:
//   ADR-0001 §"Locked-in specifics → Cron":
//     "one Vercel Cron entry at every-5-min hitting /api/cron/refresh-spreads,
//     authenticated by CRON_SECRET header."

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  CRON_ROUTE,
  MAX_CRON_INTERVAL_MINUTES,
  cronIntervalMinutes,
} from "./helpers/cron-fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VercelCronEntry {
  path: string;
  schedule: string;
}

interface VercelJson {
  crons?: VercelCronEntry[];
  [key: string]: unknown;
}

function loadVercelJson(): VercelJson {
  const vercelJsonPath = join(REPO_ROOT, "vercel.json");
  if (!existsSync(vercelJsonPath)) {
    throw new Error(
      `vercel.json not found at ${vercelJsonPath}. ` +
        `ADR-0001 §"Locked-in specifics → Cron": ` +
        `"one Vercel Cron entry at */5 * * * * hitting /api/cron/refresh-spreads". ` +
        `Create vercel.json with: { "crons": [{ "path": "/api/cron/refresh-spreads", "schedule": "*/5 * * * *" }] }`
    );
  }
  try {
    return JSON.parse(readFileSync(vercelJsonPath, "utf8")) as VercelJson;
  } catch (err) {
    throw new Error(
      `vercel.json exists but is not valid JSON: ${(err as Error).message}. ` +
        `Fix the JSON syntax in vercel.json.`
    );
  }
}

// ---------------------------------------------------------------------------
// Suite: Vercel Cron registration (DoD item 1)
// ---------------------------------------------------------------------------

describe("DoD 1 — Vercel Cron registration (ADR-0001 §'Locked-in specifics → Cron')", () => {
  it("vercel.json exists at the repo root", () => {
    const vercelJsonPath = join(REPO_ROOT, "vercel.json");
    expect(
      existsSync(vercelJsonPath),
      `vercel.json not found at ${vercelJsonPath}. ` +
        `ADR-0001 mandates: "one Vercel Cron entry at */5 * * * * hitting ` +
        `/api/cron/refresh-spreads". ` +
        `Create vercel.json with at minimum: ` +
        `{ "crons": [{ "path": "/api/cron/refresh-spreads", "schedule": "*/5 * * * *" }] }`
    ).toBe(true);
  });

  it("vercel.json contains a 'crons' array", () => {
    const config = loadVercelJson();
    expect(
      Array.isArray(config.crons),
      `vercel.json exists but has no "crons" array. ` +
        `Vercel Cron requires: { "crons": [{ "path": "...", "schedule": "..." }] }. ` +
        `ADR-0001: the cron entry goes in vercel.json's "crons" key.`
    ).toBe(true);

    expect(
      (config.crons ?? []).length > 0,
      `vercel.json has an empty "crons" array. ` +
        `At minimum one entry is required: ` +
        `{ "path": "${CRON_ROUTE}", "schedule": "*/5 * * * *" }`
    ).toBe(true);
  });

  it(`vercel.json has a cron entry for path "${CRON_ROUTE}"`, () => {
    const config = loadVercelJson();
    const entry = (config.crons ?? []).find((c) => c.path === CRON_ROUTE);

    expect(
      entry,
      `No cron entry with path="${CRON_ROUTE}" found in vercel.json. ` +
        `ADR-0001 §"Locked-in specifics → Cron": ` +
        `"one Vercel Cron entry at */5 * * * * hitting /api/cron/refresh-spreads". ` +
        `Found paths: ${JSON.stringify((config.crons ?? []).map((c) => c.path))}. ` +
        `Add: { "path": "${CRON_ROUTE}", "schedule": "*/5 * * * *" } to the "crons" array.`
    ).toBeDefined();
  });

  it(`cron entry for "${CRON_ROUTE}" has a 'schedule' field`, () => {
    const config = loadVercelJson();
    const entry = (config.crons ?? []).find((c) => c.path === CRON_ROUTE);

    // If previous test already failed this is undefined — let it fail gracefully
    expect(
      entry?.schedule,
      `Cron entry for "${CRON_ROUTE}" is missing a "schedule" field. ` +
        `Vercel Cron requires a cron expression in the "schedule" field. ` +
        `Example: { "path": "${CRON_ROUTE}", "schedule": "*/5 * * * *" }`
    ).toBeTruthy();
  });

  it(`cron schedule fires at an interval ≤${MAX_CRON_INTERVAL_MINUTES} minutes (ADR-0001: "*/5 * * * *" or finer)`, () => {
    const config = loadVercelJson();
    const entry = (config.crons ?? []).find((c) => c.path === CRON_ROUTE);
    const schedule = entry?.schedule ?? "";

    const intervalMinutes = cronIntervalMinutes(schedule);

    expect(
      intervalMinutes,
      `Cron expression "${schedule}" for path "${CRON_ROUTE}" ` +
        `fires every ${intervalMinutes} minutes (or could not be parsed — got Infinity). ` +
        `ADR-0001 requires an interval of ≤${MAX_CRON_INTERVAL_MINUTES} minutes. ` +
        `Use "*/5 * * * *" for exactly 5 minutes, ` +
        `"*/1 * * * *" for 1 minute (maximum allowed by Vercel Hobby in 2026), ` +
        `or any step that divides into 5 minutes.`
    ).toBeLessThanOrEqual(MAX_CRON_INTERVAL_MINUTES);
  });

  it(`cron schedule is exactly the 5-minute value ADR-0001 explicitly pins`, () => {
    const config = loadVercelJson();
    const entry = (config.crons ?? []).find((c) => c.path === CRON_ROUTE);
    const schedule = entry?.schedule ?? "";

    // ADR-0001 §"Locked-in specifics → Cron" pins schedule = "*/5 * * * *"
    // ("star/5 star star star star" — every 5 minutes)
    const EXPECTED_SCHEDULE = ["*", "5", " ", "*", " ", "*", " ", "*", " ", "*"].join("").replace(" ", "").replace(/\s/g, " ");
    // Build the expected string without triggering esbuild's JSDoc parser:
    const FIVE_MIN_CRON = [
      String.fromCharCode(42), // *
      "/5 * * * *",
    ].join("");

    expect(
      schedule,
      `Cron schedule is "${schedule}" but ADR-0001 §"Locked-in specifics → Cron" ` +
        `explicitly pins "${FIVE_MIN_CRON}". ` +
        `If a finer cadence is chosen (e.g. every-1-minute), update this test ` +
        `and the ADR together — the DoD contract is ≤5 minutes, and the ADR ` +
        `pins the exact string. The test pins the ADR.`
    ).toBe(FIVE_MIN_CRON);
  });

  it("vercel.json is valid JSON with no parse errors", () => {
    // This test passes trivially if loadVercelJson() did not throw above.
    // It exists as an explicit checkpoint so a malformed vercel.json gives
    // a named, findable failure rather than a cascade.
    const vercelJsonPath = join(REPO_ROOT, "vercel.json");
    if (!existsSync(vercelJsonPath)) {
      throw new Error(
        `vercel.json missing — cannot validate JSON. Create the file first.`
      );
    }
    const raw = readFileSync(vercelJsonPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `vercel.json is not valid JSON: ${(err as Error).message}. ` +
          `Fix the syntax. Offending content (first 200 chars): ${raw.slice(0, 200)}`
      );
    }
    expect(parsed, "vercel.json parsed to a non-object").toMatchObject({});
  });

  it("CRON_SECRET is documented in .env.example", () => {
    // ADR-0001: "CRON_SECRET header". The variable must be in .env.example
    // so developers know to set it. This test verifies the contract is surfaced.
    const envExamplePath = join(REPO_ROOT, ".env.example");
    expect(
      existsSync(envExamplePath),
      `.env.example not found at ${envExamplePath}. ` +
        `The CRON_SECRET env var must be documented in .env.example.`
    ).toBe(true);

    const envExample = readFileSync(envExamplePath, "utf8");
    expect(
      envExample.includes("CRON_SECRET"),
      `.env.example does not document CRON_SECRET. ` +
        `ADR-0001: the cron handler is authenticated by CRON_SECRET header. ` +
        `Add a CRON_SECRET entry to .env.example (can be commented out).`
    ).toBe(true);
  });
});
