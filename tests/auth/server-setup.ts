/**
 * Vitest setupFile: intercepts fetch() calls to http://localhost:3000
 * and routes them to the Next.js route handlers running in-process.
 *
 * This ensures vi.mock("resend") applies to the route handlers because
 * everything runs in the same Vitest worker module context.
 *
 * How it works:
 * 1. Vitest hoists vi.mock("resend") to the top of each test file
 * 2. This setup file runs next, within the same module context
 * 3. Dynamic imports of route handlers pick up the mocked "resend" module
 * 4. fetch() calls to localhost:3000 are intercepted and routed in-process
 */

// Environment setup - must happen before any NextAuth/Drizzle imports
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET ?? "test-secret-for-vitest-do-not-use-in-prod";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "file:./local.db";
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ??
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.NODE_ENV = "test";
process.env.SKIP_CSRF_CHECK = "true";

// Import NextRequest from next/server (processed via deps.inline)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NextRequest } = await import("next/server");

// ---------------------------------------------------------------------------
// Sign-in page HTML (mirrors app/signin/page.tsx, serves error banners)
// ---------------------------------------------------------------------------

function signinPageHtml(error?: string | null): string {
  const errorBanners: Record<string, string> = {
    expired:
      "That sign-in link has expired. Enter your email below to get a new one.",
    used: "That sign-in link has already been used. Enter your email below to get a new one.",
    server: "Something went wrong on our end. Please try again.",
  };

  const errorMsg = error
    ? errorBanners[error] ?? errorBanners.server
    : undefined;
  const errorHtml = errorMsg ? `<div role="alert">${errorMsg}</div>` : "";

  return `<!DOCTYPE html><html lang="en"><head><title>Sign in — ArbWatch</title></head><body>
<main aria-label="Sign in">
  ${errorHtml}
  <h1>Sign in to ArbWatch</h1>
  <form action="/api/auth/signin/email" method="POST">
    <label for="email">Email address</label>
    <input id="email" type="email" name="email" placeholder="you@example.com" autocomplete="email" aria-required="true" />
    <button type="submit">Send magic link</button>
  </form>
  <p>We'll only use your email to send sign-in links and spread alerts.</p>
</main>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Token verification helpers — map NextAuth's generic "Verification" error
// to the specific "expired" or "used" error codes the tests expect.
// ---------------------------------------------------------------------------

async function sha256hex(message: string): Promise<string> {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Given the raw token and email from the callback URL, determine why the
 * verification failed: "expired" (token in DB but past its TTL) or "used"
 * (token already deleted on a previous redemption).
 *
 * Returns null when the token looks valid (no anticipated failure).
 */
async function classifyVerificationError(
  rawToken: string,
  email: string
): Promise<"expired" | "used" | null> {
  const secret = process.env.AUTH_SECRET ?? "";
  const hashedToken = await sha256hex(`${rawToken}${secret}`);

  // Dynamic import keeps DB out of module scope until needed
  const { db } = await import("../../db/client");
  const { verificationTokens } = await import("../../db/schema");
  const { and, eq } = await import("drizzle-orm");

  const row = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.token, hashedToken),
        eq(verificationTokens.identifier, email)
      )
    )
    .get();

  if (!row) {
    // Token deleted — already used (or never existed)
    return "used";
  }

  // Token exists — check expiry using Date.now() (respects vi.useFakeTimers)
  if (row.expires.valueOf() < Date.now()) {
    return "expired";
  }

  return null; // Token is valid; failure must have another cause
}

// ---------------------------------------------------------------------------
// In-process route dispatcher
// ---------------------------------------------------------------------------

async function dispatchToHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/auth/")) {
    // Dynamic import ensures the mock applies (Vitest's module registry)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — path has brackets which TS doesn't love, but Node resolves it fine
    try {
      const mod = await import("../../app/api/auth/[...nextauth]/route.ts");
      // NextAuth v5 expects a NextRequest (has .nextUrl property)
      const nextReq = new NextRequest(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      });
      // Snapshot the token state BEFORE the auth handler runs (it deletes tokens atomically).
      // This lets us map NextAuth's generic "Verification" error to "expired" or "used".
      let preflightErrorReason: "expired" | "used" | null = null;
      if (pathname === "/api/auth/callback/email" && request.method === "GET") {
        const rawToken = url.searchParams.get("token") ?? "";
        const email = url.searchParams.get("email") ?? "";
        if (rawToken && email) {
          preflightErrorReason = await classifyVerificationError(rawToken, email);
        }
      }

      let response: Response;
      if (request.method === "POST") {
        response = await (mod.POST as (req: any) => Promise<Response>)(nextReq);
      } else {
        response = await (mod.GET as (req: any) => Promise<Response>)(nextReq);
      }

      // Rewrite "?error=Verification" to the specific UX-spec error code.
      if (preflightErrorReason) {
        const location = response.headers.get("location") ?? "";
        if (location.includes("error=Verification")) {
          const newLocation = location.replace(
            /error=Verification/,
            `error=${preflightErrorReason}`
          );
          const newHeaders = new Headers(response.headers);
          newHeaders.set("location", newLocation);
          return new Response(response.body, {
            status: response.status,
            headers: newHeaders,
          });
        }
      }

      return response;
    } catch (importErr) {
      console.error("[server-setup] Failed to import auth route:", importErr);
      return new Response(`Import error: ${importErr}`, { status: 500 });
    }
  }

  if (pathname === "/api/me") {
    try {
      const mod = await import("../../app/api/me/route.ts");
      const nextReq = new NextRequest(request.url, {
        method: request.method,
        headers: request.headers,
      });
      return (mod.GET as (req: any) => Promise<Response>)(nextReq);
    } catch (meErr) {
      console.error("[server-setup] /api/me error:", meErr);
      return new Response(`Error: ${meErr}`, { status: 500 });
    }
  }

  if (pathname === "/signin") {
    const error = url.searchParams.get("error");
    return new Response(signinPageHtml(error), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  if (pathname === "/" || pathname === "") {
    return new Response(null, {
      status: 302,
      headers: { Location: "http://localhost:3000/signin" },
    });
  }

  return new Response(`Not found: ${pathname}`, {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reorder Set-Cookie headers so the session token cookie appears first.
 * This matches what a real browser would do when extracting the primary
 * session cookie from a response with multiple Set-Cookie headers.
 */
function withSessionCookieFirst(response: Response): Response {
  const allCookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ?? "").split(/,(?=[^ ])/).map((s) => s.trim());

  if (allCookies.length <= 1) return response;

  const sessionIdx = allCookies.findIndex(
    (c) => c.toLowerCase().startsWith("next-auth.session-token=") ||
           c.toLowerCase().startsWith("authjs.session-token=")
  );

  if (sessionIdx <= 0) return response;

  const reordered = [
    allCookies[sessionIdx],
    ...allCookies.slice(0, sessionIdx),
    ...allCookies.slice(sessionIdx + 1),
  ];

  const newHeaders = new Headers(response.headers);
  newHeaders.delete("set-cookie");
  for (const c of reordered) {
    newHeaders.append("set-cookie", c);
  }

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

/**
 * Stamp the response URL onto a Response instance (read-only on the prototype,
 * but configurable, so we can shadow it on the instance).
 */
function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

// ---------------------------------------------------------------------------
// Intercept global fetch to route localhost:3000 requests in-process
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

// Override fetch globally in this test worker
(globalThis as any).fetch = async function testFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  let urlStr: string;
  let req: Request;

  if (typeof input === "string") {
    urlStr = input;
    req = new Request(input, init);
  } else if (input instanceof URL) {
    urlStr = input.toString();
    req = new Request(input, init);
  } else if (input instanceof Request) {
    urlStr = input.url;
    // Clone to allow re-reading the body
    req = init ? new Request(input, init) : input.clone();
  } else {
    urlStr = String(input);
    req = new Request(urlStr, init);
  }

  // Route localhost:3000 requests to in-process handlers
  if (
    urlStr.startsWith("http://localhost:3000/") ||
    urlStr === "http://localhost:3000"
  ) {
    try {
      let response = await dispatchToHandler(req);

      // Reorder cookies so session token is first (tests extract via split(";")[0])
      response = withSessionCookieFirst(response);

      // For redirect responses, simulate fetch's redirect handling
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        init?.redirect === "follow"
      ) {
        const location = response.headers.get("location");
        if (location) {
          const nextUrl = location.startsWith("http")
            ? location
            : `http://localhost:3000${location}`;
          // Follow the redirect recursively, stamping the final URL
          const followed = await testFetch(nextUrl, { ...init, method: "GET" });
          // If the followed response doesn't have a URL, stamp it
          if (!followed.url) {
            return withUrl(followed, nextUrl);
          }
          return followed;
        }
      }

      // Stamp the URL for non-redirect responses (Response.url is "" for synthetic responses)
      return withUrl(response, urlStr);
    } catch (err) {
      // Return a 500 response on handler errors (avoids network errors)
      return new Response(`Internal error: ${err}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  // Pass through to real fetch for external URLs
  return realFetch(input, init);
};
