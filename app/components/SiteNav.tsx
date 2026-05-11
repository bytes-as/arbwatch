import { cookies } from "next/headers";
import { db } from "../../db/client";
import { users, sessions } from "../../db/schema";
import { eq, and, gt } from "drizzle-orm";

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function getIsLoggedIn(): Promise<boolean> {
  const cookieStore = await cookies();
  const sessionToken =
    cookieStore.get(SESSION_COOKIE_NAME)?.value ??
    cookieStore.get("next-auth.session-token")?.value ??
    cookieStore.get("authjs.session-token")?.value;

  if (!sessionToken) return false;

  const now = new Date();
  const [result] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  return !!result;
}

export default async function SiteNav() {
  const loggedIn = await getIsLoggedIn();

  return (
    <nav className="site-nav" aria-label="Site navigation">
      <a href="/" aria-label="ArbWatch home" className="site-nav-logo">
        ArbWatch<span className="site-nav-logo-cursor" aria-hidden="true">|</span>
      </a>
      <div className="site-nav-links">
        <a href="/about" className="site-nav-link">About</a>
        {loggedIn ? (
          <a href="/dashboard" className="site-nav-cta">Dashboard →</a>
        ) : (
          <a href="/signin" className="site-nav-cta">Sign in →</a>
        )}
      </div>
    </nav>
  );
}
