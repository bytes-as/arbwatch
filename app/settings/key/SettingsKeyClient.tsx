"use client";

import { useRef, useState, useEffect, FormEvent } from "react";

/** Minimum key length per ADR-0002 / backend MIN_KEY_LENGTH */
const MIN_KEY_LENGTH = 20;

const ERROR_FORMAT =
  "That doesn't look like a valid Anakin API key. Check for extra spaces or missing characters.";
const ERROR_GENERIC =
  "Something went wrong saving your key. Try again in a moment.";

export default function SettingsKeyClient() {
  const inputRef = useRef<HTMLInputElement>(null);

  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [removeSuccess, setRemoveSuccess] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string | null>(null);
  const confirmYesRef = useRef<HTMLButtonElement>(null);

  // Fetch current key status on mount
  useEffect(() => {
    fetch("/api/me/anakin-key", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.status) setCurrentStatus(data.status); })
      .catch(() => {});
  }, []);

  // Autofocus the input on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Move focus to "Yes, remove" when confirm dialog opens
  useEffect(() => {
    if (removeConfirm) {
      confirmYesRef.current?.focus();
    }
  }, [removeConfirm]);

  function validateFormat(value: string): boolean {
    const trimmed = value.trim();
    return !!(trimmed && trimmed.length >= MIN_KEY_LENGTH);
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

      const elapsed = Date.now() - start;
      if (elapsed < 200) {
        await new Promise((r) => setTimeout(r, 200 - elapsed));
      }

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setCurrentStatus(data.status ?? "ok");
        setSuccessMessage("Key saved successfully.");
        setKeyValue("");
        setSubmitting(false);
        return;
      }

      if (res.status === 401) {
        window.location.href = "/signin?error=expired";
        return;
      }

      setError(res.status === 400 ? ERROR_FORMAT : ERROR_GENERIC);
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

  async function handleRemoveConfirmed() {
    setRemoveConfirm(false);
    setRemoving(true);

    try {
      const res = await fetch("/api/me/anakin-key", {
        method: "DELETE",
        credentials: "include",
      });

      if (res.ok || res.status === 204) {
        setRemoveSuccess(true);
      } else if (res.status === 401) {
        window.location.href = "/signin?error=expired";
        return;
      }
    } catch {
      // ignore — user can retry
    } finally {
      setRemoving(false);
    }
  }

  if (removeSuccess) {
    return (
      <div className="settings-remove-success">
        <p role="status" className="success-message">
          Your Anakin key has been removed. Add a new key to resume spread
          tracking.
        </p>
        <a href="/onboarding/key" className="btn-primary" style={{ display: "inline-flex", textDecoration: "none", marginTop: "1rem" }}>
          Add a new key
        </a>
      </div>
    );
  }

  return (
    <div className="settings-key-content">
      {/* Current key status */}
      {currentStatus && (
        <div className="settings-section" style={{ paddingBottom: "1rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", color: currentStatus === "ok" ? "var(--color-success, #4ade80)" : "var(--color-muted, #888)" }}>
            {currentStatus === "ok" && "✓ Anakin key is active"}
            {currentStatus === "key-missing" && "No key set"}
            {currentStatus === "key-invalid" && "⚠ Key is invalid — paste a new one below"}
            {currentStatus === "quota-exhausted" && "⚠ Quota exhausted — paste a new key or wait for reset"}
          </p>
        </div>
      )}

      {/* Rotate section */}
      <section aria-labelledby="rotate-heading" className="settings-section">
        <h2 id="rotate-heading" className="settings-section-heading">
          {currentStatus === "ok" ? "Rotate your Anakin key" : "Add your Anakin key"}
        </h2>
        <p className="auth-sub">
          Paste your new key below. The old key will be replaced immediately.
        </p>

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
                disabled={submitting || removing}
                className="field-input"
              />

              <button
                type="button"
                aria-pressed={showKey}
                aria-label={showKey ? "Hide key" : "Show key"}
                onClick={() => setShowKey((v) => !v)}
                disabled={submitting || removing}
                className="btn-toggle-visibility"
              >
                {showKey ? "Hide key" : "Show key"}
              </button>
            </div>

            {/* Always in DOM for stable aria-describedby */}
            <p
              id="key-error"
              role="alert"
              className={error ? "field-error" : "field-error sr-only"}
            >
              {error}
            </p>
          </div>

          <p id="key-security-note" className="auth-note">
            Your key is encrypted before it is stored and is only used to make
            Wire calls on your behalf. It is never logged or shared with third
            parties.
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
              "Save key"
            )}
          </button>
        </form>
      </section>

      {/* Remove section */}
      <section aria-labelledby="remove-heading" className="settings-section settings-section-danger">
        <h2 id="remove-heading" className="settings-section-heading">
          Remove Anakin key
        </h2>
        <p className="auth-sub">
          Removing your key will pause spread tracking until you add a new one.
        </p>

        {removeConfirm ? (
          <div role="group" aria-label="Confirm key removal" className="remove-confirm-group">
            <p className="auth-sub">
              Are you sure? This will pause all spread tracking.
            </p>
            <div className="remove-confirm-actions">
              <button
                ref={confirmYesRef}
                type="button"
                onClick={handleRemoveConfirmed}
                className="btn-danger"
                disabled={removing}
              >
                Yes, remove
              </button>
              <button
                type="button"
                onClick={() => setRemoveConfirm(false)}
                className="btn-ghost"
                disabled={removing}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRemoveConfirm(true)}
            disabled={removing}
            className="btn-danger"
          >
            {removing ? "Removing…" : "Remove key"}
          </button>
        )}
      </section>
    </div>
  );
}
