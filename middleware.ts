import { NextRequest, NextResponse } from "next/server";

// Cookie name used by NextAuth v5 database sessions (dev mode).
// In production (secure: true), it becomes __Secure-next-auth.session-token.
const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

export function middleware(req: NextRequest) {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME);
  const hasSession = !!sessionCookie?.value;

  // Logged-in users going to /signin skip past it to the dashboard
  if (hasSession && pathname === "/signin") {
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  // Redirect unauthenticated users away from protected routes
  if (
    !hasSession &&
    (pathname === "/dashboard" ||
      pathname.startsWith("/onboarding") ||
      pathname.startsWith("/settings"))
  ) {
    return NextResponse.redirect(new URL("/signin", nextUrl));
  }
}

export const config = {
  matcher: ["/", "/signin", "/dashboard", "/onboarding/:path*", "/settings/:path*", "/api/me"],
};
