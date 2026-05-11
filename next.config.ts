import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use the Node.js runtime (not Edge) per ADR-0001
  // @noble/ciphers + Drizzle + better-sqlite3 require Node.js.
  //
  // better-sqlite3 must be external because it uses native bindings.
  // @noble/ciphers similarly needs external treatment.
  // All drizzle-orm packages must be bundled together to ensure the
  // DrizzleAdapter's `is()` prototype check uses the same class instance
  // as the db/client.ts Drizzle initialization.
  serverExternalPackages: ["better-sqlite3", "@noble/ciphers"],

  async rewrites() {
    // Map the test-only private-folder URL to a real API route.
    // Next.js excludes folders starting with _ from routing, so
    // app/__test/ is never compiled into the route table. This rewrite
    // lets Playwright tests reach the mock-inbox endpoint at the
    // hard-coded URL /__test/mock-inbox/latest.
    return [
      {
        source: "/__test/mock-inbox/latest",
        destination: "/api/test-inbox/latest",
      },
    ];
  },
};

export default nextConfig;
