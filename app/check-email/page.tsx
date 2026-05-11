import type { Metadata } from "next";
import ResendButton from "./ResendButton";

export const metadata: Metadata = {
  title: "Check your inbox — ArbWatch",
};

interface CheckEmailPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Obfuscate an email address per UX spec §5B:
 * Show first two chars, then ***, then @domain.
 * If local part is one char, show that char then ***.
 */
function obfuscateEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex < 0) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);

  // Truncate if needed (edge case E1: max 40 visible chars before obfuscation)
  const displayLocal =
    local.length > 40 ? local.slice(0, 40) + "…" : local;

  const prefix = displayLocal.length <= 1 ? displayLocal : displayLocal.slice(0, 2);
  return `${prefix}***${domain}`;
}

export default async function CheckEmailPage({ searchParams }: CheckEmailPageProps) {
  const params = await searchParams;
  const rawEmail =
    typeof params.email === "string" ? params.email : undefined;

  const displayEmail = rawEmail ? obfuscateEmail(rawEmail) : null;

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <main
        id="main-content"
        aria-label="Email sent confirmation"
        className="auth-main"
      >
        <div>
          <a href="/" aria-label="ArbWatch home" className="auth-wordmark">
            ArbWatch
          </a>
          <section className="auth-card">
            {/* Envelope illustration — decorative */}
            <div className="check-email-icon" aria-hidden="true">
              ✉️
            </div>

            <div className="check-email-detail">
              <h1>Check your inbox</h1>

              <p>
                We sent a sign-in link to{" "}
                {displayEmail ? (
                  <strong>{displayEmail}</strong>
                ) : (
                  "your email address"
                )}
                . Click the link in that email to continue.
              </p>

              {/* TODO: sync with ADR-0001 TTL */}
              <p>The link expires in 15 minutes.</p>

              <div className="resend-row">
                <p>Didn&apos;t get it?</p>
                <ResendButton email={rawEmail} />
              </div>

              <a href="/signin" className="link-primary">
                Use a different email address
              </a>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
