import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "../../../db/client";
import { users, sessions } from "../../../db/tables";
import { eq, and, gt } from "drizzle-orm";
import SettingsKeyClient from "./SettingsKeyClient";

export const metadata: Metadata = {
  title: "Settings — ArbWatch",
};

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function resolveSession(): Promise<boolean> {
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
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  return !!result;
}

export default async function SettingsKeyPage() {
  const isAuthenticated = await resolveSession();

  if (!isAuthenticated) {
    redirect("/signin");
  }

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <main id="main-content" aria-label="Settings" className="settings-main">
        <nav className="settings-nav">
          <a href="/dashboard" aria-label="ArbWatch home" className="auth-wordmark" style={{ marginBottom: "0" }}>
            ArbWatch
          </a>
          <a href="/dashboard" className="link-primary settings-back-link">
            ← Back to dashboard
          </a>
        </nav>

        <div className="settings-container">
          <h1 className="settings-heading">Settings</h1>
          <SettingsKeyClient />
        </div>
      </main>
    </>
  );
}
