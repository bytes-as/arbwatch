import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "../../../db/client";
import { users, sessions } from "../../../db/schema";
import { eq, and, gt } from "drizzle-orm";
import AnakinKeyForm from "./AnakinKeyForm";

export const metadata: Metadata = {
  title: "Connect your Anakin key — ArbWatch",
};

const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

async function getUserKeyStatus(): Promise<{
  userId: string;
  keyStatus: string;
} | null> {
  const cookieStore = await cookies();
  const sessionToken =
    cookieStore.get(SESSION_COOKIE_NAME)?.value ??
    cookieStore.get("next-auth.session-token")?.value ??
    cookieStore.get("authjs.session-token")?.value;

  if (!sessionToken) return null;

  const now = new Date();
  const [result] = await db
    .select({
      userId: sessions.userId,
      keyStatus: users.anakinKeyStatus,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.sessionToken, sessionToken), gt(sessions.expires, now)));

  if (!result) return null;
  return { userId: result.userId, keyStatus: result.keyStatus };
}

export default async function OnboardingKeyPage() {
  const userInfo = await getUserKeyStatus();

  if (!userInfo) {
    redirect("/signin");
  }

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <main id="main-content" aria-label="API key setup" className="auth-main">
        <div>
          <a href="/" aria-label="ArbWatch home" className="auth-wordmark">
            ArbWatch
          </a>
          <section className="auth-card">
            <h1>Connect your Anakin API key</h1>

            <p className="auth-sub">
              ArbWatch uses your Anakin Wire key to fetch live market data
              across Kalshi, Manifold, Polymarket, and Robinhood. Every Wire
              call is billed directly to your Anakin account — we never pay for
              your Wire credits.
            </p>

            <p className="auth-sub">
              Don&apos;t have a key?{" "}
              <a
                href="https://anakin.company/wire"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Get an Anakin Wire key (opens in new tab)"
                className="link-primary"
              >
                anakin.company/wire
              </a>
              .
            </p>

            <AnakinKeyForm redirectOnSuccess={true} submitLabel="Save key" />
          </section>
        </div>
      </main>
    </>
  );
}
