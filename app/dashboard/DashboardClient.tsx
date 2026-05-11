"use client";

import { useEffect, useState, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import dynamic from "next/dynamic";
import type { WatchedQuestion } from "./WatchedSection";

// WatchedSection is loaded client-side only so that interactive elements
// (Remove buttons, form inputs) are only present in the DOM after React has
// fully hydrated.  The test's waitFor calls naturally block until the
// component mounts, ensuring event handlers are attached before any click.
const WatchedSection = dynamic(() => import("./WatchedSection"), { ssr: false });

class WatchedSectionBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("[WatchedSection crash]", err, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "1rem", color: "var(--color-error-text)", fontFamily: "var(--font-mono)", fontSize: "0.875rem" }}>
          Dashboard failed to load: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

type KeyStatus = "ok" | "key-invalid" | "quota-exhausted" | "key-missing";

interface DashboardClientProps {
  keyStatus: KeyStatus;
  showWelcomeToast: boolean;
  userEmail: string;
  initialQuestions: WatchedQuestion[];
}

const BANNER_COPY: Record<string, { body: string }> = {
  "key-invalid": {
    body: "Your Anakin key was rejected — paste a fresh one in Settings.",
  },
  "quota-exhausted": {
    body: "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin account at anakin.company/wire to resume.",
  },
  "key-missing": {
    body: "Add an Anakin key in Settings to start watching markets.",
  },
};

export default function DashboardClient({
  keyStatus,
  showWelcomeToast,
  userEmail,
  initialQuestions,
}: DashboardClientProps) {
  const [toastVisible, setToastVisible] = useState(showWelcomeToast);

  // Auto-dismiss the welcome toast after 5 seconds
  useEffect(() => {
    if (!showWelcomeToast) return;
    const timer = setTimeout(() => setToastVisible(false), 5_000);
    return () => clearTimeout(timer);
  }, [showWelcomeToast]);

  const hasKeyError =
    keyStatus === "key-invalid" ||
    keyStatus === "quota-exhausted" ||
    keyStatus === "key-missing";
  const bannerBody = hasKeyError ? BANNER_COPY[keyStatus]?.body : undefined;

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <main
        id="main-content"
        aria-label="Watched questions dashboard"
        className="dashboard-main"
      >
        {/* Nav bar */}
        <nav className="dashboard-nav">
          <a href="/" aria-label="ArbWatch home" className="site-nav-logo" style={{ marginBottom: 0 }}>
            ArbWatch<span className="site-nav-logo-cursor" aria-hidden="true">|</span>
          </a>
          <div className="dashboard-nav-actions">
            <a href="/about" className="link-primary dashboard-settings-link">
              About
            </a>
            <a href="/settings/key" className="link-primary dashboard-settings-link">
              Key settings
            </a>
            <a href="/settings/notifications" className="link-primary dashboard-settings-link">
              Notifications
            </a>
          </div>
        </nav>

        {/* Welcome toast */}
        {toastVisible && (
          <div role="status" className="welcome-toast">
            You&apos;re all set. Start watching your first question below.
          </div>
        )}

        {/* Key-error banner — always in DOM as empty for pre-registered aria-live */}
        <div
          id="key-error-banner"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          aria-label={hasKeyError ? "API key error" : undefined}
        >
          {hasKeyError && bannerBody && (
            <div className="key-error-banner-content">
              <span className="key-error-icon" aria-label="Error">!</span>
              <div className="key-error-text">
                <strong>Wire calls paused</strong>
                <p>{bannerBody}</p>
              </div>
              <a
                href="/settings/key"
                className="key-error-cta"
                aria-label="Update your Anakin key in Settings"
              >
                Update key
              </a>
            </div>
          )}
        </div>

        {/* Watched questions section — header, form, list */}
        <WatchedSectionBoundary>
          <WatchedSection initialQuestions={initialQuestions} />
        </WatchedSectionBoundary>

        {/* Disclaimer sub-header */}
        <p id="spread-disclaimer" className="dashboard-disclaimer">
          arb &#8800; profit; slippage and fees may eat spread
        </p>

        {/* Footer */}
        <footer className="dashboard-footer">
          <p>arb &#8800; profit; slippage and fees may eat spread</p>
          <p>Spread data refreshes every 5 minutes.</p>
        </footer>
      </main>
    </>
  );
}
