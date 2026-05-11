"use client";

import { useState, useEffect } from "react";

interface PushToggleProps {
  vapidPublicKey: string;
}

type ToggleState = "loading" | "unsupported" | "denied" | "enabled" | "disabled";

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0))).buffer;
}

export default function PushToggle({ vapidPublicKey }: PushToggleProps) {
  const [state, setState] = useState<ToggleState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      return;
    }

    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setState(sub ? "enabled" : "disabled");
      }).catch(() => setState("disabled"));
    }).catch(() => setState("unsupported"));
  }, []);

  async function enablePush() {
    setBusy(true);
    setError("");
    try {
      const reg = await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const json = sub.toJSON();
      const p256dh = json.keys?.p256dh ?? "";
      const auth = json.keys?.auth ?? "";

      const res = await fetch("/api/me/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ endpoint: sub.endpoint, p256dh, auth }),
      });

      if (!res.ok) {
        throw new Error(`Server rejected subscription: ${res.status}`);
      }

      setState("enabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable push alerts.");
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    setBusy(true);
    setError("");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setState("disabled");
        return;
      }

      await fetch("/api/me/push-subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });

      await sub.unsubscribe();
      setState("disabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable push alerts.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return <p className="push-toggle-status">Checking notification status…</p>;
  }

  if (state === "unsupported") {
    return (
      <p className="push-toggle-status push-toggle-status--muted">
        Push notifications are not supported in this browser.
      </p>
    );
  }

  if (state === "denied") {
    return (
      <p className="push-toggle-status push-toggle-status--muted">
        Notifications are blocked. Enable them in your browser settings, then reload this page.
      </p>
    );
  }

  return (
    <div className="push-toggle">
      <div className="push-toggle-row">
        <span className="push-toggle-label">
          Push alerts: <strong>{state === "enabled" ? "On" : "Off"}</strong>
        </span>
        <button
          type="button"
          className={`push-toggle-btn${state === "enabled" ? " push-toggle-btn--active" : ""}`}
          disabled={busy}
          onClick={state === "enabled" ? disablePush : enablePush}
          aria-pressed={state === "enabled"}
        >
          {busy ? "…" : state === "enabled" ? "Disable push alerts" : "Enable push alerts"}
        </button>
      </div>
      {error && <p className="push-toggle-error" role="alert">{error}</p>}
    </div>
  );
}
