"use client";

import { useState, useEffect, useRef } from "react";

const COOLDOWN_SECONDS = 60;

interface ResendButtonProps {
  email?: string;
}

type ResendStatus = "idle" | "cooldown" | "success" | "error";

export default function ResendButton({ email }: ResendButtonProps) {
  const [status, setStatus] = useState<ResendStatus>("idle");
  const [secondsLeft, setSecondsLeft] = useState(COOLDOWN_SECONDS);
  const [ariaCountdown, setAriaCountdown] = useState(COOLDOWN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ariaUpdateCountRef = useRef(0);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function startCooldown() {
    setSecondsLeft(COOLDOWN_SECONDS);
    setAriaCountdown(COOLDOWN_SECONDS);
    ariaUpdateCountRef.current = 0;
    setStatus("cooldown");

    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        const next = prev - 1;
        ariaUpdateCountRef.current += 1;
        // Update aria-label every 5 seconds to reduce screen-reader verbosity
        if (ariaUpdateCountRef.current % 5 === 0) {
          setAriaCountdown(next);
        }
        if (next <= 0) {
          clearInterval(intervalRef.current!);
          setStatus("idle");
        }
        return next;
      });
    }, 1000);
  }

  async function handleResend() {
    if (status === "cooldown" || !email) return;

    try {
      const csrfRes = await fetch("/api/auth/csrf", { credentials: "include" });
      const csrfData = await csrfRes.json().catch(() => ({}));
      const csrfToken: string = csrfData?.csrfToken ?? "";

      const body = new URLSearchParams({
        email,
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

      if (res.ok || res.status === 302 || res.status === 0) {
        setStatus("success");
        startCooldown();
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  const isCooldown = status === "cooldown";
  const buttonLabel = isCooldown
    ? `Resend (${secondsLeft}s)`
    : "Resend";

  const ariaLabel = isCooldown
    ? `Resend disabled, wait ${ariaCountdown} seconds`
    : "Resend";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.375rem" }}>
      <button
        type="button"
        onClick={handleResend}
        disabled={isCooldown}
        aria-disabled={isCooldown ? "true" : undefined}
        aria-label={ariaLabel}
        className="btn-ghost"
      >
        {buttonLabel}
      </button>

      {status === "success" && (
        <p role="status" className="check-email-inline-msg" style={{ color: "green" }}>
          A new link is on its way.
        </p>
      )}
      {status === "error" && (
        <p role="alert" className="check-email-inline-msg" style={{ color: "var(--color-error-text)" }}>
          Couldn&apos;t send the email. Try again in a moment.
        </p>
      )}
    </div>
  );
}
