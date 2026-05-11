/**
 * tests/watched/seed-reporter.ts
 *
 * Playwright reporter that resets the fixture DB after each watched-dashboard
 * test completes. Calls POST /api/test-reset (dev-only) which deletes all
 * non-seed questions for the fixture user, restoring the 3-question baseline.
 *
 * Uses execFileSync so the reset completes synchronously before Playwright's
 * next test starts (sequential test execution with workers:1).
 */

import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { execFileSync } from "node:child_process";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

class SeedReporter implements Reporter {
  onTestEnd(test: TestCase, _result: TestResult): void {
    if (!test.location.file.includes("dashboard-watched")) return;

    try {
      execFileSync("curl", [
        "-s",
        "-X",
        "POST",
        `${BASE_URL}/api/test-reset`,
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
      ]);
    } catch (err) {
      console.error("[seed-reporter] DB reset failed:", err);
    }
  }
}

export default SeedReporter;
