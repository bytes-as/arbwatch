import type { Metadata } from "next";
import SignInForm from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in — ArbWatch",
};

interface SignInPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const errorParam =
    typeof params.error === "string" ? params.error : undefined;

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <main id="main-content" aria-label="Sign in" className="auth-main">
        <div>
          <a href="/" aria-label="ArbWatch home" className="auth-wordmark">
            ArbWatch
          </a>
          <section className="auth-card">
            <SignInForm errorParam={errorParam} />
          </section>
        </div>
      </main>
    </>
  );
}
