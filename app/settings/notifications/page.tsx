import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "../../../db/client";
import { sessions } from "../../../db/schema";
import { eq, and, gt } from "drizzle-orm";
import PushToggle from "./PushToggle";

export const metadata: Metadata = {
  title: "Notification Settings — ArbWatch",
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

  return result !== undefined;
}

export default async function NotificationSettingsPage() {
  const isAuthenticated = await resolveSession();
  if (!isAuthenticated) {
    redirect("/signin");
  }

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? "";

  return (
    <main className="settings-page">
      <h1 className="settings-heading">Notification Settings</h1>

      <section className="settings-section">
        <h2 className="settings-section-heading">Push Alerts</h2>
        <p className="settings-section-description">
          Receive browser push notifications when a spread threshold is crossed.
          You will also continue to receive email alerts.
        </p>

        {vapidPublicKey ? (
          <PushToggle vapidPublicKey={vapidPublicKey} />
        ) : (
          <p className="push-toggle-status push-toggle-status--muted">
            Push alerts are not configured on this server.
          </p>
        )}
      </section>
    </main>
  );
}
