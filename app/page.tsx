import type { Metadata } from "next";
import type React from "react";
import { cookies } from "next/headers";
import { db } from "../db/client";
import { users, sessions } from "../db/tables";
import { eq, and, gt } from "drizzle-orm";

export const metadata: Metadata = {
  title: "ArbWatch — Prediction market spread tracker",
  description:
    "Prediction markets disagree on the same question. ArbWatch finds those gaps and tells you how to profit from them.",
};

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

export default async function LandingPage() {
  const loggedIn = await getIsLoggedIn();
  const ctaHref = loggedIn ? "/dashboard" : "/signin";
  const ctaLabel = loggedIn ? "Go to dashboard →" : "Sign in →";

  return (
    <div className="lp-root">

      {/* ── NAV ──────────────────────────────────────────────────────── */}
      <nav className="lp-nav">
        <span className="lp-nav-logo">
          ArbWatch<span className="lp-cursor" aria-hidden="true">|</span>
        </span>
        <a href={ctaHref} className="lp-nav-cta">{ctaLabel}</a>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="lp-hero">
        {/* Ambient grid */}
        <div className="lp-grid" aria-hidden="true" />

        {/* Floating price bars — background decoration */}
        <div className="lp-bars" aria-hidden="true">
          <div className="lp-bar" style={{ "--bar-h": "22%", "--bar-color": "#4337c9" } as React.CSSProperties}>
            <div className="lp-bar-fill" />
            <span className="lp-bar-label">MANI</span>
            <span className="lp-bar-prob">22%</span>
          </div>
          <div className="lp-bar" style={{ "--bar-h": "38%", "--bar-color": "#0095e6" } as React.CSSProperties}>
            <div className="lp-bar-fill" />
            <span className="lp-bar-label">POLY</span>
            <span className="lp-bar-prob">38%</span>
          </div>
          <div className="lp-bar" style={{ "--bar-h": "45%", "--bar-color": "#00c805" } as React.CSSProperties}>
            <div className="lp-bar-fill" />
            <span className="lp-bar-label">RH</span>
            <span className="lp-bar-prob">45%</span>
          </div>
          <div className="lp-bar" style={{ "--bar-h": "31%", "--bar-color": "#00b388" } as React.CSSProperties}>
            <div className="lp-bar-fill" />
            <span className="lp-bar-label">KALS</span>
            <span className="lp-bar-prob">31%</span>
          </div>
        </div>

        {/* Spread badge */}
        <div className="lp-spread-badge" aria-hidden="true">
          <span className="lp-spread-badge-label">SPREAD</span>
          <span className="lp-spread-badge-value">23.0%</span>
          <span className="lp-spread-badge-arrow">↑</span>
        </div>

        {/* Hero text */}
        <div className="lp-hero-text">
          <h1 className="lp-hero-name">
            ArbWatch<span className="lp-cursor" aria-hidden="true">|</span>
          </h1>
          <p className="lp-hero-tagline">Track the gap. Spot the edge.</p>
          <a href={ctaHref} className="lp-hero-cta">{ctaLabel}</a>
          <p className="lp-hero-scroll" aria-hidden="true">scroll to learn more ↓</p>
        </div>
      </section>

      {/* ── PROBLEM ──────────────────────────────────────────────────── */}
      <section className="lp-section lp-problem">
        <div className="lp-section-inner">
          <p className="lp-eyebrow">THE PROBLEM</p>
          <h2 className="lp-section-h">
            The same question.<br />
            Four different answers.
          </h2>
          <p className="lp-section-body">
            Manifold, Polymarket, Robinhood, and Kalshi all trade the same real-world events —
            but they disagree on the probability, sometimes by 20 points or more.
            That gap is free money for anyone who catches it first.
          </p>

          {/* Live example card */}
          <div className="lp-example-card">
            <p className="lp-example-question">Will the US confirm alien life exists before 2027?</p>
            <div className="lp-example-rows">
              <div className="lp-example-row">
                <span className="lp-example-platform" style={{ color: "#4337c9" }}>Manifold</span>
                <div className="lp-example-bar-wrap">
                  <div className="lp-example-bar" style={{ width: "18%", background: "#4337c9" }} />
                </div>
                <span className="lp-example-prob">18%</span>
              </div>
              <div className="lp-example-row">
                <span className="lp-example-platform" style={{ color: "#0095e6" }}>Polymarket</span>
                <div className="lp-example-bar-wrap">
                  <div className="lp-example-bar" style={{ width: "35%", background: "#0095e6" }} />
                </div>
                <span className="lp-example-prob">35%</span>
              </div>
              <div className="lp-example-row">
                <span className="lp-example-platform" style={{ color: "#00c805" }}>Robinhood</span>
                <div className="lp-example-bar-wrap">
                  <div className="lp-example-bar" style={{ width: "41%", background: "#00c805" }} />
                </div>
                <span className="lp-example-prob">41%</span>
              </div>
              <div className="lp-example-row">
                <span className="lp-example-platform" style={{ color: "#00b388" }}>Kalshi</span>
                <div className="lp-example-bar-wrap">
                  <div className="lp-example-bar" style={{ width: "29%", background: "#00b388" }} />
                </div>
                <span className="lp-example-prob">29%</span>
              </div>
            </div>
            <div className="lp-example-spread-row">
              <span className="lp-example-spread-label">Spread</span>
              <span className="lp-example-spread-value">23.0%</span>
              <span className="lp-example-spread-trade">Buy YES on Manifold (18¢) + NO on Robinhood (59¢) = 77¢ cost, $1.00 payout</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── SOLUTION ─────────────────────────────────────────────────── */}
      <section className="lp-section lp-solution">
        <div className="lp-section-inner">
          <p className="lp-eyebrow">THE SOLUTION</p>
          <h2 className="lp-section-h">
            One dashboard.<br />
            Every spread, live.
          </h2>
          <p className="lp-section-body">
            ArbWatch scans all four platforms simultaneously, matches equivalent markets,
            and surfaces the spread in real time. No manual tab-switching.
            No missed opportunities.
          </p>

          <div className="lp-pillars">
            <div className="lp-pillar">
              <span className="lp-pillar-icon" aria-hidden="true">⟳</span>
              <h3 className="lp-pillar-h">Live prices</h3>
              <p className="lp-pillar-body">Fetches current bids from every platform on demand. Always fresh.</p>
            </div>
            <div className="lp-pillar">
              <span className="lp-pillar-icon" aria-hidden="true">◎</span>
              <h3 className="lp-pillar-h">Auto-matching</h3>
              <p className="lp-pillar-body">Type a question once — we find the equivalent market on every platform automatically.</p>
            </div>
            <div className="lp-pillar">
              <span className="lp-pillar-icon" aria-hidden="true">△</span>
              <h3 className="lp-pillar-h">Arb calculator</h3>
              <p className="lp-pillar-body">Exact trade instructions: which platform to buy YES on, which to buy NO on, and your expected return.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────── */}
      <section className="lp-section lp-howto">
        <div className="lp-section-inner lp-section-inner--narrow">
          <p className="lp-eyebrow">HOW IT WORKS</p>
          <ol className="lp-steps">
            <li className="lp-step">
              <span className="lp-step-num">01</span>
              <div>
                <strong>Search for a question</strong>
                <p>e.g. "Fed rate cut 2025" or "who wins the election"</p>
              </div>
            </li>
            <li className="lp-step">
              <span className="lp-step-num">02</span>
              <div>
                <strong>We find every matching market</strong>
                <p>Across Manifold, Polymarket, Robinhood, and Kalshi — instantly</p>
              </div>
            </li>
            <li className="lp-step">
              <span className="lp-step-num">03</span>
              <div>
                <strong>Watch the spread</strong>
                <p>Get alerted when the gap exceeds your threshold</p>
              </div>
            </li>
            <li className="lp-step">
              <span className="lp-step-num">04</span>
              <div>
                <strong>Execute the trade</strong>
                <p>Buy YES on the cheap platform, NO on the expensive one — lock in the spread</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ── CTA FOOTER ───────────────────────────────────────────────── */}
      <section className="lp-cta-section">
        <div className="lp-cta-inner">
          <h2 className="lp-cta-h">Ready to find the gaps?</h2>
          <a href={ctaHref} className="lp-cta-btn">{ctaLabel}</a>
          <p className="lp-cta-footnote">arb ≠ guaranteed profit — slippage and fees can eat the spread</p>
        </div>
      </section>

    </div>
  );
}
