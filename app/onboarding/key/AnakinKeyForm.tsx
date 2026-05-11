"use client";

import { useRef, useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";

/** Minimum key length per ADR-0002 / backend MIN_KEY_LENGTH */
const MIN_KEY_LENGTH = 20;

const ERROR_FORMAT =
  "That doesn't look like a valid Anakin API key. Check for extra spaces or missing characters.";
const ERROR_KEY_INVALID =
  "Anakin rejected this key. Double-check it in your Anakin dashboard and paste it again.";
const ERROR_QUOTA_EXHAUSTED =
  "Your Anakin account has no remaining Wire quota. Top up your balance at anakin.company/wire, then paste your key again.";
const ERROR_GENERIC =
  "Something went wrong saving your key. Try again in a moment.";
const ERROR_SESSION_EXPIRED =
  "Your session has expired. Sign in again to continue.";

interface AnakinKeyFormProps {
  /**
   * When true: after save, redirect to /dashboard?welcome=1.
   * When false (settings): stay on the page, show a success message.
   */
  redirectOnSuccess: boolean;
  /**
   * Label for the submit button.
   */
  submitLabel: string;
}

export default function AnakinKeyForm({
  redirectOnSuccess,
  submitLabel,
}: AnakinKeyFormProps) {
  const router = useRouter();

  const inputRef = useRef<HTMLInputElement>(null);

  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);

  // Autofocus the input on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  function validateFormat(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < MIN_KEY_LENGTH) return false;
    return true;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const trimmed = keyValue.trim();

    if (!validateFormat(trimmed)) {
      setError(ERROR_FORMAT);
      inputRef.current?.focus();
      return;
    }

    setError("");
    setSuccessMessage("");
    setSubmitting(true);

    const start = Date.now();

    try {
      const res = await fetch("/api/me/anakin-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ key: trimmed }),
      });

      // Enforce minimum 200 ms spinner
      const elapsed = Date.now() - start;
      if (elapsed < 200) {
        await new Promise((r) => setTimeout(r, 200 - elapsed));
      }

      if (res.ok) {
        if (redirectOnSuccess) {
          router.push("/dashboard?welcome=1");
          return;
        }
        setSuccessMessage("Key saved successfully.");
        setKeyValue("");
        setSubmitting(false);
        return;
      }

      if (res.status === 401) {
        setSessionExpired(true);
        setKeyValue("");
        setSubmitting(false);
        return;
      }

      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const serverError = typeof body.error === "string" ? body.error : "";

      if (res.status === 400) {
        setError(ERROR_FORMAT);
      } else if (serverError.includes("key-invalid")) {
        setError(ERROR_KEY_INVALID);
      } else if (serverError.includes("quota-exhausted")) {
        setError(ERROR_QUOTA_EXHAUSTED);
      } else {
        setError(ERROR_GENERIC);
      }

      setSubmitting(false);
    } catch {
      const elapsed = Date.now() - start;
      if (elapsed < 200) {
        await new Promise((r) => setTimeout(r, 200 - elapsed));
      }
      setError(ERROR_GENERIC);
      setSubmitting(false);
    }
  }

  if (sessionExpired) {
    return (
      <div role="alert" className="error-banner">
        {ERROR_SESSION_EXPIRED}{" "}
        <a href="/signin" className="link-primary">
          Sign in
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form" noValidate>
      <div className="field-group">
        <label htmlFor="anakin-key" className="field-label">
          Anakin API key
        </label>

        <div className="key-input-wrapper">
          <input
            ref={inputRef}
            id="anakin-key"
            type={showKey ? "text" : "password"}
            name="anakin-key"
            value={keyValue}
            onChange={(e) => {
              setKeyValue(e.currentTarget.value);
              if (error) setError("");
            }}
            placeholder="Paste your key here"
            autoComplete="off"
            spellCheck={false}
            aria-required="true"
            aria-invalid={error ? "true" : undefined}
            aria-describedby="key-security-note key-error"
            maxLength={256}
            disabled={submitting}
            className="field-input"
          />

          <button
            type="button"
            aria-pressed={showKey}
            aria-label={showKey ? "Hide key" : "Show key"}
            onClick={() => setShowKey((v) => !v)}
            disabled={submitting}
            className="btn-toggle-visibility"
          >
            {showKey ? "Hide key" : "Show key"}
          </button>
        </div>

        {/* Always present in DOM (even when empty) so aria-describedby reference is stable */}
        <p id="key-error" role="alert" className={error ? "field-error" : "field-error sr-only"}>
          {error}
        </p>
      </div>

      <p id="key-security-note" className="auth-note">
        Your key is encrypted before it is stored and is only used to make Wire
        calls on your behalf. It is never logged or shared with third parties.
      </p>

      {successMessage && (
        <p role="status" className="success-message">
          {successMessage}
        </p>
      )}

      <button
        type="submit"
        aria-disabled={submitting ? "true" : undefined}
        aria-label={submitting ? "Saving key…" : undefined}
        className="btn-primary"
        style={{ pointerEvents: submitting ? "none" : undefined }}
      >
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">Saving key…</span>
          </>
        ) : (
          submitLabel
        )}
      </button>
    </form>
  );
}
