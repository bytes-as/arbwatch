"use client";

import { useRef, useState, useEffect, FormEvent } from "react";

const ERROR_COPY: Record<string, string> = {
  expired:
    "That sign-in link has expired. Enter your email below to get a new one.",
  used: "That sign-in link has already been used. Enter your email below to get a new one.",
  server: "Something went wrong on our end. Please try again.",
};

interface SignInFormProps {
  errorParam?: string;
}

export default function SignInForm({ errorParam }: SignInFormProps) {
  const errorMessage = errorParam
    ? (ERROR_COPY[errorParam] ?? ERROR_COPY.server)
    : undefined;

  const bannerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [emailError, setEmailError] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // Move focus to error banner on mount when an error param is present
  useEffect(() => {
    if (errorMessage && bannerRef.current) {
      bannerRef.current.focus();
    } else if (!errorMessage && inputRef.current) {
      inputRef.current.focus();
    }
  }, [errorMessage]);

  function validateEmail(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.currentTarget.value;
    if (value && !validateEmail(value)) {
      setEmailError("Enter a valid email address.");
    } else {
      setEmailError("");
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const emailInput = form.elements.namedItem("email") as HTMLInputElement;
    const emailValue = emailInput.value.trim();

    if (!validateEmail(emailValue)) {
      setEmailError("Enter a valid email address.");
      inputRef.current?.focus();
      return;
    }

    setEmailError("");
    setSubmitting(true);

    const start = Date.now();

    try {
      // Fetch CSRF token required by NextAuth
      const csrfRes = await fetch("/api/auth/csrf", { credentials: "include" });
      const csrfData = await csrfRes.json().catch(() => ({}));
      const csrfToken: string = csrfData?.csrfToken ?? "";

      const body = new URLSearchParams({
        email: emailValue,
        csrfToken,
        callbackUrl: "/dashboard",
        redirect: "false",
        json: "true",
      });

      const res = await fetch("/api/auth/signin/email", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "include",
        redirect: "manual",
      });

      // Enforce minimum 200ms spinner
      const elapsed = Date.now() - start;
      if (elapsed < 200) {
        await new Promise((resolve) => setTimeout(resolve, 200 - elapsed));
      }

      if (res.ok || res.status === 302 || res.status === 0) {
        // Redirect to /check-email with the email so the page can echo it
        window.location.href = `/check-email?email=${encodeURIComponent(emailValue)}`;
        return;
      }

      // Server error
      setSubmitting(false);
      setEmailError("Something went wrong. Try again.");
    } catch {
      const elapsed = Date.now() - start;
      if (elapsed < 200) {
        await new Promise((resolve) => setTimeout(resolve, 200 - elapsed));
      }
      setSubmitting(false);
      setEmailError("Something went wrong. Try again.");
    }
  }

  return (
    <>
      {errorMessage && (
        <div
          role="alert"
          className="error-banner"
          tabIndex={-1}
          ref={bannerRef}
        >
          {errorMessage}
        </div>
      )}

      <h1>Sign in to ArbWatch</h1>
      <p className="auth-sub">
        Enter your email and we&apos;ll send you a one-time sign-in link. No
        password needed.
      </p>

      <form
        onSubmit={handleSubmit}
        aria-label="Sign in with email"
        className="auth-form"
        noValidate
      >
        <div className="field-group">
          <label htmlFor="email" className="field-label">
            Email address
          </label>
          <input
            ref={inputRef}
            id="email"
            type="email"
            name="email"
            placeholder="you@example.com"
            autoComplete="email"
            aria-required="true"
            aria-invalid={emailError ? "true" : undefined}
            aria-describedby={emailError ? "email-error" : undefined}
            onBlur={handleBlur}
            onChange={() => emailError && setEmailError("")}
            disabled={submitting}
            className="field-input"
          />
          {emailError && (
            <span id="email-error" role="alert" className="field-error">
              {emailError}
            </span>
          )}
        </div>

        <button
          type="submit"
          aria-disabled={submitting ? "true" : undefined}
          aria-label={submitting ? "Sending…" : undefined}
          className="btn-primary"
          style={{ pointerEvents: submitting ? "none" : undefined }}
        >
          {submitting ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span className="sr-only">Sending…</span>
            </>
          ) : (
            "Send magic link"
          )}
        </button>
      </form>

      <p className="auth-note">
        We&apos;ll only use your email to send sign-in links and spread alerts.
      </p>
    </>
  );
}
