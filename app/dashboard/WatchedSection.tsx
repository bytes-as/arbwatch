"use client";

import {
  useRef,
  useState,
  useEffect,
  useActionState,
  useCallback,
  useMemo,
  FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { addWatchedQuestionAction, removeWatchedQuestionAction } from "./actions";

// ---------------------------------------------------------------------------
// Search result type (mirrors app/api/search/route.ts)
// ---------------------------------------------------------------------------

interface SearchResult {
  platform: Platform;
  market_id: string;
  market_title: string;
  market_url: string | null;
  implied_yes_prob: number | null;
}

// ---------------------------------------------------------------------------
// Exported types (used by page.tsx and DashboardClient.tsx)
// ---------------------------------------------------------------------------

export type Platform = "kalshi" | "manifold" | "polymarket" | "robinhood";

export interface PlatformMatch {
  platform: Platform;
  market_id: string;
  market_url: string | null;
  market_title: string | null;
  implied_yes_prob: number | null;
  close_date?: string | null;
}

export interface SpreadHistoryPoint {
  spread: number | null;
  computed_at: number;
}

export interface WatchedQuestion {
  id: string;
  query_text: string;
  created_at: number;
  spread: number | null;
  last_updated: number | null;
  matches: PlatformMatch[];
  threshold: number | null;
  history: SpreadHistoryPoint[];
  pending?: boolean;
}

// ---------------------------------------------------------------------------
// Locked copy strings per docs/design/dashboard.md §5B / §5C
// ---------------------------------------------------------------------------

const INPUT_LABEL = "Search prediction markets";
const REMOVE_BUTTON_LABEL = "Remove";
const CAP_EXCEEDED_MESSAGE =
  "You've reached the 5-question limit. Remove a question to add a new one.";
const EMPTY_STATE_HEADING = "You're not watching any questions yet.";
const EMPTY_STATE_SUBTEXT = "Search above and click a market to start tracking spreads.";
const MAX_QUERY_TEXT_LENGTH = 280;
const QUESTION_CAP = 5;
const SEARCH_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WatchedSectionProps {
  initialQuestions: WatchedQuestion[];
}

// ---------------------------------------------------------------------------
// WatchedRow — individual question row with inline confirmation
//
// The Remove button is a real <button> element.  On click React renders the
// inline confirmation in its place.  Confirmation content is only mounted
// while that row's confirmation is open, avoiding strict-mode violations when
// Playwright runs getByText('Remove this question?').
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Platform display names and order
// ---------------------------------------------------------------------------

const PLATFORM_ORDER: Platform[] = ["kalshi", "manifold", "polymarket", "robinhood"];

const PLATFORM_DISPLAY: Record<Platform, string> = {
  kalshi: "Kalshi",
  manifold: "Manifold",
  polymarket: "Polymarket",
  robinhood: "Robinhood",
};

// ---------------------------------------------------------------------------
// Spread rendering helpers
// ---------------------------------------------------------------------------

function formatSpreadPercent(spread: number): string {
  return `${(spread * 100).toFixed(1)}%`;
}

function computeSpreadDirection(history: SpreadHistoryPoint[]): "up" | "down" | null {
  const valid = history.filter((h): h is { spread: number; computed_at: number } => h.spread !== null);
  if (valid.length < 2) return null;
  const recent = valid[valid.length - 1].spread;
  const prev = valid[valid.length - 2].spread;
  if (recent > prev + 0.002) return "up";
  if (recent < prev - 0.002) return "down";
  return null;
}

function formatCloseDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffDays = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (diffDays < 0) return "expired";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays < 30) return `${diffDays}d`;
  if (diffDays < 365) return `${Math.round(diffDays / 30)}mo`;
  return `${Math.round(diffDays / 365)}yr`;
}

function formatVolume(platform: string, volume: number): string {
  // Manifold volume is in Mana (play money), others are real USD
  const isFake = platform === "manifold";
  const prefix = isFake ? "M" : "$";
  if (volume >= 1_000_000) return `${prefix}${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${prefix}${(volume / 1_000).toFixed(0)}K`;
  return `${prefix}${Math.round(volume)}`;
}

function getSpreadClass(spread: number | null): string {
  if (spread === null) return "spread--unavailable";
  if (spread > 0.03) return "spread--alert";
  return "spread--neutral";
}

function getSpreadAriaLabel(spread: number | null): string {
  if (spread === null) return "Spread unavailable — only one platform matched this question";
  const formatted = formatSpreadPercent(spread);
  if (spread > 0.03) return `Spread: ${formatted} — above alert threshold`;
  return `Spread: ${formatted}`;
}

// ---------------------------------------------------------------------------
// Timestamp rendering helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(lastUpdatedMs: number, nowMs: number): string {
  const diffMs = nowMs - lastUpdatedMs;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const date = new Date(lastUpdatedMs);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function getTimestampClass(lastUpdatedMs: number, nowMs: number): string {
  const diffMin = Math.floor((nowMs - lastUpdatedMs) / 60_000);
  if (diffMin > 10) return "timestamp--stale";
  return "timestamp--fresh";
}

function getTimestampAriaLabel(
  relativeText: string,
  lastUpdatedMs: number,
  nowMs: number
): string {
  const diffMin = Math.floor((nowMs - lastUpdatedMs) / 60_000);
  if (diffMin > 10) return `Last updated ${relativeText} — data may be stale`;
  return `Last updated ${relativeText}`;
}

// ---------------------------------------------------------------------------
// SpreadCell component
// ---------------------------------------------------------------------------

function SpreadCell({ spread, history }: { spread: number | null; history?: SpreadHistoryPoint[] }) {
  const cls = getSpreadClass(spread);
  const ariaLabel = getSpreadAriaLabel(spread);
  const displayText = spread === null ? "—" : formatSpreadPercent(spread);
  const direction = history ? computeSpreadDirection(history) : null;

  return (
    <span className={`watched-spread ${cls}`} aria-label={ariaLabel}>
      {displayText}
      {direction && (
        <span
          className={`spread-direction spread-direction--${direction}`}
          aria-hidden="true"
        >
          {direction === "up" ? "↑" : "↓"}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TimestampCell component
// ---------------------------------------------------------------------------

function TimestampCell({ lastUpdated }: { lastUpdated: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (lastUpdated === null) return null;

  // last_updated is stored as Unix seconds in spread_snapshots; normalise to ms
  const lastUpdatedMs = lastUpdated < 1e12 ? lastUpdated * 1000 : lastUpdated;

  const relativeText = formatRelativeTime(lastUpdatedMs, now);
  const cls = getTimestampClass(lastUpdatedMs, now);
  const ariaLabel = getTimestampAriaLabel(relativeText, lastUpdatedMs, now);

  return (
    <span className={`watched-timestamp ${cls}`} aria-label={ariaLabel}>
      {relativeText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ThresholdControl component
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.03;
const THRESHOLD_STEP_PCT = 0.1;
const THRESHOLD_MIN_PCT = 0.5;
const THRESHOLD_MAX_PCT = 10;

function formatThresholdPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

interface ThresholdControlProps {
  questionId: string;
  threshold: number | null;
  onThresholdChange: (id: string, newThreshold: number | null) => void;
}

function ThresholdControl({ questionId, threshold, onThresholdChange }: ThresholdControlProps) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = `threshold-label-${questionId}`;
  const errorId = `threshold-error-${questionId}`;
  const liveId = `threshold-live-${questionId}`;
  const [liveMessage, setLiveMessage] = useState("");

  function openEditor() {
    const currentPct =
      threshold !== null
        ? (threshold * 100).toFixed(1)
        : (DEFAULT_THRESHOLD * 100).toFixed(1);
    setInputValue(currentPct);
    setError("");
    setEditing(true);
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && editing) {
        setEditing(false);
        setError("");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pct = parseFloat(inputValue);
    if (isNaN(pct) || pct < THRESHOLD_MIN_PCT || pct > THRESHOLD_MAX_PCT) {
      setError(`Enter a value between ${THRESHOLD_MIN_PCT}% and ${THRESHOLD_MAX_PCT}%.`);
      inputRef.current?.focus();
      return;
    }
    const fraction = parseFloat((pct / 100).toFixed(4));
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/watched/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threshold: fraction }),
      });
      if (res.ok) {
        onThresholdChange(questionId, fraction);
        setEditing(false);
        setLiveMessage(`Alert threshold updated to ${formatThresholdPercent(fraction)}.`);
      } else {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const msg = typeof body.error === "string" ? body.error : "Couldn't save threshold.";
        setError(msg);
        inputRef.current?.focus();
      }
    } catch {
      setError("Couldn't save threshold. Try again.");
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/watched/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threshold: null }),
      });
      if (res.ok) {
        onThresholdChange(questionId, null);
        setEditing(false);
        setLiveMessage(`Alert threshold reset to default (${formatThresholdPercent(DEFAULT_THRESHOLD)}).`);
      } else {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const msg = typeof body.error === "string" ? body.error : "Couldn't reset threshold.";
        setError(msg);
      }
    } catch {
      setError("Couldn't reset threshold. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="threshold-editor">
        <form onSubmit={handleSave} className="threshold-form">
          <label id={labelId} htmlFor={`threshold-input-${questionId}`} className="threshold-form-label">
            Alert at:
          </label>
          <div className="threshold-input-row">
            <input
              ref={inputRef}
              id={`threshold-input-${questionId}`}
              type="number"
              step={THRESHOLD_STEP_PCT}
              min={THRESHOLD_MIN_PCT}
              max={THRESHOLD_MAX_PCT}
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.currentTarget.value);
                if (error) setError("");
              }}
              aria-labelledby={labelId}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? "true" : undefined}
              className="threshold-input field-input"
              disabled={saving}
            />
            <span className="threshold-pct-unit" aria-hidden="true">%</span>
            <button
              type="submit"
              className="btn-ghost threshold-save-btn"
              disabled={saving}
            >
              Save
            </button>
            <button
              type="button"
              className="btn-ghost threshold-cancel-btn"
              onClick={() => { setEditing(false); setError(""); }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="field-error threshold-error">
              {error}
            </p>
          )}
        </form>
        {threshold !== null && (
          <button
            type="button"
            className="btn-ghost threshold-reset-btn"
            onClick={handleReset}
            disabled={saving}
          >
            Reset to default ({formatThresholdPercent(DEFAULT_THRESHOLD)})
          </button>
        )}
        <span id={liveId} role="status" aria-live="polite" className="sr-only">
          {liveMessage}
        </span>
      </div>
    );
  }

  const isDefault = threshold === null;
  const displayPct = isDefault
    ? `${formatThresholdPercent(DEFAULT_THRESHOLD)} (default)`
    : formatThresholdPercent(threshold);

  return (
    <div className="threshold-display">
      <button
        type="button"
        className={`threshold-label-btn btn-ghost${isDefault ? " threshold-label-btn--default" : ""}`}
        onClick={openEditor}
        aria-label={
          isDefault
            ? `Alert threshold: ${formatThresholdPercent(DEFAULT_THRESHOLD)}, default — click to change`
            : `Alert threshold: ${formatThresholdPercent(threshold)} — click to change`
        }
      >
        Alert at: {displayPct}
      </button>
      <span id={liveId} role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline component
// ---------------------------------------------------------------------------

const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 32;
const SPARKLINE_PADDING = 4;

function Sparkline({
  history,
  width = SPARKLINE_WIDTH,
  height = SPARKLINE_HEIGHT,
}: {
  history: SpreadHistoryPoint[];
  width?: number;
  height?: number;
}) {
  const points = history.filter((h): h is { spread: number; computed_at: number } =>
    h.spread !== null
  );

  if (points.length < 2) return null;

  const spreads = points.map((p) => p.spread);
  const minSpread = Math.min(...spreads);
  const maxSpread = Math.max(...spreads);
  const spreadRange = maxSpread - minSpread || 0.001;

  const timestamps = points.map((p) => p.computed_at);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  const plotW = width - 2 * SPARKLINE_PADDING;
  const plotH = height - 2 * SPARKLINE_PADDING;

  const svgPoints = points
    .map((p) => {
      const x = SPARKLINE_PADDING + ((p.computed_at - minTs) / tsRange) * plotW;
      const y = SPARKLINE_PADDING + ((maxSpread - p.spread) / spreadRange) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const minPct = `${(minSpread * 100).toFixed(1)}%`;
  const maxPct = `${(maxSpread * 100).toFixed(1)}%`;
  const ariaLabel = `Spread over last 7 days: min ${minPct}, max ${maxPct}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={ariaLabel}
      role="img"
      className="sparkline"
      style={{ overflow: "visible" }}
    >
      <polyline
        points={svgPoints}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// PlatformChips component
// ---------------------------------------------------------------------------

function PlatformChips({ matches }: { matches: PlatformMatch[] }) {
  // Only render chips for platforms that actually have a match
  const orderedMatches = PLATFORM_ORDER
    .map((platform) => matches.find((m) => m.platform === platform))
    .filter((m): m is PlatformMatch => m != null);

  if (orderedMatches.length === 0) return null;

  return (
    <div className="watched-chips">
      {orderedMatches.map((match) => {
        const displayName = PLATFORM_DISPLAY[match.platform];
        const prob = match.implied_yes_prob != null
          ? `${(match.implied_yes_prob * 100).toFixed(0)}%`
          : null;
        const title = match.market_title ?? undefined;

        if (match.market_url) {
          return (
            <a
              key={match.platform}
              href={match.market_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${displayName}: ${prob ?? "no price"} — ${title ?? "view market"} (opens in new tab)`}
              className="watched-chip watched-chip--matched"
              title={title}
            >
              <span className="chip-dot" style={{ background: PLATFORM_COLORS[match.platform] }} />
              <span className="chip-platform">{displayName}</span>
              {prob && <span className="chip-prob">{prob}</span>}
            </a>
          );
        }

        // Has a market_id but no URL (e.g. Kalshi) — show as non-linked chip
        return (
          <span
            key={match.platform}
            aria-label={`${displayName}: ${prob ?? "no price"}${title ? ` — ${title}` : ""}`}
            className="watched-chip watched-chip--matched watched-chip--no-link"
            title={title}
          >
            <span className="chip-dot" style={{ background: PLATFORM_COLORS[match.platform] }} />
            <span className="chip-platform">{displayName}</span>
            {prob && <span className="chip-prob">{prob}</span>}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Platform color map (shared between chips and modal)
// ---------------------------------------------------------------------------

const PLATFORM_COLORS: Record<Platform, string> = {
  kalshi: "#00b388",
  manifold: "#4337c9",
  polymarket: "#0095e6",
  robinhood: "#00c805",
};

// ---------------------------------------------------------------------------
// QuestionDetailModal
// ---------------------------------------------------------------------------

interface FreshPrice {
  platform: string;
  market_id: string;
  implied_yes_prob: number | null;
  close_date: string | null;
  volume: number | null;
}

interface QuestionDetailModalProps {
  question: WatchedQuestion;
  onClose: () => void;
  onThresholdChange: (id: string, newThreshold: number | null) => void;
  onMatchesChange: (id: string, newMatches: PlatformMatch[]) => void;
}

const PLATFORM_URL_INSTRUCTIONS: Record<Platform, string> = {
  kalshi: "kalshi.com/markets/KXETHD-25DEC31 → paste full URL or just the ticker",
  manifold: "manifold.markets/username/market-slug → paste the full URL",
  polymarket: "polymarket.com/event/event-slug → paste the full URL",
  robinhood: "robinhood.com/us/en/prediction-markets/category/events/event-slug/ → paste the full URL",
};

function QuestionDetailModal({ question, onClose, onThresholdChange, onMatchesChange }: QuestionDetailModalProps) {
  const [freshData, setFreshData] = useState<Map<string, FreshPrice> | null>(null);
  const [loadingPrices, setLoadingPrices] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Re-match state (global = fill missing; per-platform = update one)
  const [rematching, setRematching] = useState(false);
  const [rematchError, setRematchError] = useState("");
  const [rematchingPlatform, setRematchingPlatform] = useState<Platform | null>(null);

  // Manual platform edit state
  const [editingPlatform, setEditingPlatform] = useState<Platform | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Per-platform delete state
  const [deletingPlatform, setDeletingPlatform] = useState<Platform | null>(null);

  // Per-platform search state
  const [searchingPlatform, setSearchingPlatform] = useState<Platform | null>(null);
  const [platformSearchQuery, setPlatformSearchQuery] = useState("");
  const [platformSearchResults, setPlatformSearchResults] = useState<SearchResult[]>([]);
  const [platformSearchLoading, setPlatformSearchLoading] = useState(false);
  const platformSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus close button on mount
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Trap focus inside modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !modalRef.current) return;
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const [refreshingPrices, setRefreshingPrices] = useState(false);

  async function fetchPrices(opts?: { showSpinner?: boolean }) {
    if (opts?.showSpinner) setRefreshingPrices(true);
    try {
      const res = await fetch(`/api/watched/${question.id}/prices`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { prices: FreshPrice[] };
        const map = new Map<string, FreshPrice>();
        for (const p of data.prices) map.set(p.platform, p);
        setFreshData(map);
        // Propagate fresh prices back to the dashboard card
        const updatedMatches = question.matches.map((m) => {
          const fresh = map.get(m.platform);
          if (!fresh) return m;
          return {
            ...m,
            implied_yes_prob: fresh.implied_yes_prob ?? m.implied_yes_prob,
            close_date: fresh.close_date ?? m.close_date,
          };
        });
        onMatchesChange(question.id, updatedMatches);
      }
    } catch { /* best-effort */ } finally {
      setLoadingPrices(false);
      if (opts?.showSpinner) setRefreshingPrices(false);
    }
  }

  // Fetch fresh prices immediately on mount
  useEffect(() => {
    let cancelled = false;
    fetchPrices().then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  // Debounced per-platform search
  useEffect(() => {
    if (!searchingPlatform || platformSearchQuery.trim().length < 2) {
      setPlatformSearchResults([]);
      return;
    }
    if (platformSearchDebounceRef.current) clearTimeout(platformSearchDebounceRef.current);
    platformSearchDebounceRef.current = setTimeout(async () => {
      setPlatformSearchLoading(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(platformSearchQuery.trim())}&platform=${searchingPlatform}`,
          { credentials: "include" }
        );
        if (res.ok) {
          const data = await res.json() as { results: SearchResult[] };
          setPlatformSearchResults(data.results ?? []);
        }
      } catch { /* ignore */ }
      finally { setPlatformSearchLoading(false); }
    }, 400);
    return () => { if (platformSearchDebounceRef.current) clearTimeout(platformSearchDebounceRef.current); };
  }, [searchingPlatform, platformSearchQuery]);

  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [calcNotional, setCalcNotional] = useState(100);
  const now = Date.now();

  async function handleRematch() {
    setRematching(true);
    setRematchError("");
    try {
      // Empty body → fill-missing mode: only searches for unmatched platforms
      const res = await fetch(`/api/watched/${question.id}/rematch`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        onMatchesChange(question.id, data.matches);
      } else {
        setRematchError("Re-match failed. Try again.");
      }
    } catch { setRematchError("Re-match failed. Try again."); }
    finally { setRematching(false); }
  }

  async function handleRematchPlatform(platform: Platform) {
    setRematchingPlatform(platform);
    setRematchError("");
    try {
      const res = await fetch(`/api/watched/${question.id}/rematch`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      if (res.ok) {
        const data = await res.json();
        onMatchesChange(question.id, data.matches);
      } else {
        setRematchError(`Re-match failed for ${platform}. Try again.`);
      }
    } catch { setRematchError(`Re-match failed for ${platform}. Try again.`); }
    finally { setRematchingPlatform(null); }
  }

  async function handleDeleteMatch(platform: Platform) {
    setDeletingPlatform(platform);
    setRematchError("");
    try {
      const res = await fetch(`/api/watched/${question.id}/match?platform=${encodeURIComponent(platform)}`, {
        method: "DELETE", credentials: "include",
      });
      if (res.ok) {
        onMatchesChange(question.id, question.matches.filter((m) => m.platform !== platform));
      } else {
        setRematchError(`Failed to remove ${platform} match. Try again.`);
      }
    } catch { setRematchError(`Failed to remove ${platform} match. Try again.`); }
    finally { setDeletingPlatform(null); }
  }

  async function handleSaveMatch(platform: Platform) {
    setEditSaving(true);
    setEditError("");
    try {
      const res = await fetch(`/api/watched/${question.id}/match`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, url: editUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        // Merge new match into question.matches
        const updated = [...question.matches.filter((m) => m.platform !== platform), data.match];
        onMatchesChange(question.id, updated);
        setEditingPlatform(null);
      } else {
        const body = await res.json().catch(() => ({}));
        setEditError(typeof body.error === "string" ? body.error : "Failed to link market.");
      }
    } catch { setEditError("Failed to link market."); }
    finally { setEditSaving(false); }
  }

  async function handleSelectPlatformSearchResult(platform: Platform, result: SearchResult) {
    setEditSaving(true);
    try {
      const res = await fetch(`/api/watched/${question.id}/match`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          url: result.market_url ?? "",
          market_id: result.market_id,
          market_title: result.market_title,
          implied_yes_prob: result.implied_yes_prob,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const updated = [...question.matches.filter((m) => m.platform !== platform), data.match];
        onMatchesChange(question.id, updated);
        setSearchingPlatform(null);
        setPlatformSearchQuery("");
        setPlatformSearchResults([]);
      } else {
        const err = await res.json().catch(() => ({}));
        console.error(`[match] failed ${res.status}:`, err);
        setRematchError(typeof err.error === "string" ? err.error : "Failed to link market.");
      }
    } catch (err) {
      console.error("[match] unexpected error:", err);
      setRematchError("Failed to link market.");
    }
    finally { setEditSaving(false); }
  }

  // All 4 platforms — matched ones show data, unmatched show "not tracked"
  const platformRows = PLATFORM_ORDER.map((p) => ({
    platform: p,
    match: question.matches.find((m) => m.platform === p) ?? null,
  }));

  // Detect if all matched platforms have expired close_dates
  const matchedRows = platformRows.filter((r) => r.match !== null);
  const allMatchesExpired = matchedRows.length > 0 && matchedRows.every((r) => {
    const closeDate = freshData?.get(r.platform)?.close_date ?? r.match?.close_date ?? null;
    if (!closeDate) return false;
    return new Date(closeDate).getTime() < Date.now();
  });
  const liveProbs = freshData
    ? matchedRows
        .map((r) => freshData.get(r.platform)?.implied_yes_prob ?? r.match!.implied_yes_prob)
        .filter((p): p is number => p !== null)
    : null;
  const liveSpread = liveProbs && liveProbs.length >= 2
    ? Math.max(...liveProbs) - Math.min(...liveProbs)
    : question.spread;

  // Spread direction from history
  const spreadDirection = computeSpreadDirection(question.history);

  // Arbitrage calculator — find cheapest YES and cheapest NO across platforms
  const arbPlatformProbs = matchedRows
    .map((r) => {
      const prob = (freshData?.get(r.platform)?.implied_yes_prob) ?? r.match!.implied_yes_prob;
      if (prob === null) return null;
      return { platform: r.platform, match: r.match!, prob };
    })
    .filter((x): x is { platform: Platform; match: PlatformMatch; prob: number } => x !== null);

  const arbMin = arbPlatformProbs.length >= 2
    ? arbPlatformProbs.reduce((a, b) => a.prob < b.prob ? a : b)
    : null;
  const arbMax = arbPlatformProbs.length >= 2
    ? arbPlatformProbs.reduce((a, b) => a.prob > b.prob ? a : b)
    : null;
  const arbCost   = arbMin && arbMax ? arbMin.prob + (1 - arbMax.prob) : null;
  const arbProfit = arbMin && arbMax ? arbMax.prob - arbMin.prob : null;
  const arbReturn = arbCost && arbProfit && arbCost > 0 ? arbProfit / arbCost : null;
  const arbInvolvesPlayMoney = arbMin?.platform === "manifold" || arbMax?.platform === "manifold";

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="modal"
      >
        {/* Header */}
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title" title={question.query_text}>{question.query_text}</h2>
          <button
            type="button"
            className="modal-rematch-btn btn-ghost"
            aria-label="Refresh prices"
            onClick={() => fetchPrices({ showSpinner: true })}
            disabled={refreshingPrices || loadingPrices}
            title="Fetch latest prices from all platforms"
          >
            {refreshingPrices
              ? <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(0,0,0,0.2)", borderTopColor: "currentColor" }} />
              : "⟳"}
          </button>
          <button
            type="button"
            className="modal-rematch-btn btn-ghost"
            aria-label="Find missing platform matches"
            onClick={handleRematch}
            disabled={rematching}
            title="Search for missing platform matches (won't touch existing ones)"
          >
            {rematching ? <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(0,0,0,0.2)", borderTopColor: "currentColor" }} /> : "↻"}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="modal-close btn-ghost"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {rematchError && (
          <p role="alert" className="field-error" style={{ margin: "0.5rem 1.25rem" }}>{rematchError}</p>
        )}

        {/* Spread summary */}
        <div className="modal-spread-row">
          <div className="modal-spread-block">
            <span className="modal-spread-label">Spread</span>
            <div className="modal-spread-value-row">
              <span className={`modal-spread-value ${getSpreadClass(liveSpread)}`}>
                {liveSpread !== null ? formatSpreadPercent(liveSpread) : "—"}
              </span>
              {spreadDirection && (
                <span
                  className={`spread-direction spread-direction--${spreadDirection}`}
                  title={spreadDirection === "up" ? "Spread widening" : "Spread narrowing"}
                  aria-label={spreadDirection === "up" ? "Spread widening" : "Spread narrowing"}
                >
                  {spreadDirection === "up" ? "↑" : "↓"}
                </span>
              )}
            </div>
          </div>
          {question.last_updated && (
            <span className="modal-last-updated">
              Updated{" "}
              {formatRelativeTime(
                question.last_updated < 1e12
                  ? question.last_updated * 1000
                  : question.last_updated,
                now
              )}
            </span>
          )}
          {question.history.length >= 2 && (
            <div className="modal-sparkline">
              <Sparkline history={question.history} width={160} height={40} />
            </div>
          )}
        </div>

        {/* Platform breakdown */}
        <div className="modal-section">
          <p className="modal-section-label">Markets</p>
          {allMatchesExpired && (
            <p className="modal-expired-banner" role="status">
              All matched markets have resolved. Spread data may be stale.
            </p>
          )}
          <ul className="modal-platforms" role="list">
            {platformRows.map(({ platform, match }) => {
              const color = PLATFORM_COLORS[platform];
              const displayName = PLATFORM_DISPLAY[platform];
              const isEditingThis = editingPlatform === platform;

              if (!match) {
                return (
                  <li key={platform} className="modal-platform-row modal-platform-row--unmatched">
                    <span className="modal-platform-dot modal-platform-dot--unmatched" aria-hidden="true" />
                    <div className="modal-platform-info">
                      <span className="modal-platform-name modal-platform-name--unmatched">
                        {displayName}
                      </span>
                      {isEditingThis ? (
                        <div className="modal-edit-platform-form">
                          <p className="modal-edit-platform-instruction">{PLATFORM_URL_INSTRUCTIONS[platform]}</p>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                            <input
                              type="url"
                              className="field-input"
                              style={{ flex: 1, minWidth: 0, fontSize: "0.875rem", padding: "0.375rem 0.5rem" }}
                              placeholder="Paste market URL…"
                              value={editUrl}
                              onChange={(e) => { setEditUrl(e.currentTarget.value); if (editError) setEditError(""); }}
                              disabled={editSaving}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="btn-ghost"
                              style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                              onClick={() => handleSaveMatch(platform)}
                              disabled={editSaving || !editUrl.trim()}
                            >
                              {editSaving ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)" }}
                              onClick={() => { setEditingPlatform(null); setEditError(""); }}
                              disabled={editSaving}
                            >
                              Cancel
                            </button>
                          </div>
                          {editError && <p role="alert" className="field-error" style={{ marginTop: "0.25rem", fontSize: "0.8125rem" }}>{editError}</p>}
                        </div>
                      ) : (
                        <>
                          <span className="modal-platform-meta">No market found for this question</span>
                          {searchingPlatform === platform && (
                            <div style={{ marginTop: "0.5rem" }}>
                              <input
                                type="text"
                                className="field-input"
                                style={{ fontSize: "0.875rem", padding: "0.375rem 0.5rem", width: "100%" }}
                                placeholder={`Search ${displayName}…`}
                                value={platformSearchQuery}
                                onChange={(e) => setPlatformSearchQuery(e.currentTarget.value)}
                                autoFocus
                              />
                              {platformSearchLoading && (
                                <p className="platform-search-status">Searching…</p>
                              )}
                              {!platformSearchLoading && platformSearchResults.length === 0 && platformSearchQuery.trim().length >= 2 && (
                                <p className="platform-search-status">No results</p>
                              )}
                              {platformSearchResults.length > 0 && (
                                <ul style={{ listStyle: "none", margin: "0.25rem 0 0", padding: 0 }}>
                                  {platformSearchResults.slice(0, 5).map((r) => (
                                    <li key={r.market_id}>
                                      <button
                                        type="button"
                                        className="platform-search-result-btn"
                                        onClick={() => handleSelectPlatformSearchResult(platform, r)}
                                        disabled={editSaving}
                                      >
                                        <span className="platform-search-result-title">{r.market_title}</span>
                                        {r.implied_yes_prob !== null && (
                                          <span className="platform-search-result-prob">
                                            {(r.implied_yes_prob * 100).toFixed(1)}%
                                          </span>
                                        )}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <button
                                type="button"
                                className="platform-search-cancel"
                                onClick={() => { setSearchingPlatform(null); setPlatformSearchQuery(""); setPlatformSearchResults([]); }}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    {!isEditingThis && (
                      <div className="modal-platform-right">
                        <span className="modal-platform-prob modal-platform-prob--unmatched">—</span>
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Re-search ${displayName} for this question`}
                          onClick={() => handleRematchPlatform(platform)}
                          title={`Re-search ${displayName}`}
                          disabled={rematchingPlatform === platform}
                        >
                          {rematchingPlatform === platform
                            ? <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(0,0,0,0.2)", borderTopColor: "currentColor" }} />
                            : "↻"}
                        </button>
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Manually link ${displayName} market`}
                          onClick={() => { setEditingPlatform(platform); setEditUrl(""); setEditError(""); setSearchingPlatform(null); }}
                          title={`Link ${displayName} market manually`}
                        >
                          ✏
                        </button>
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Search ${displayName} for a different market`}
                          title={`Search ${displayName}`}
                          onClick={() => {
                            setSearchingPlatform(platform);
                            setPlatformSearchQuery("");
                            setPlatformSearchResults([]);
                            setEditingPlatform(null);
                          }}
                          style={searchingPlatform === platform ? { color: "var(--color-accent, #60a5fa)" } : undefined}
                        >
                          🔍
                        </button>
                      </div>
                    )}
                  </li>
                );
              }

              const fresh = freshData?.get(platform);
              const prob = fresh?.implied_yes_prob ?? match.implied_yes_prob;
              const isRefreshing = loadingPrices;
              const probDisplay = prob !== null && prob !== undefined
                ? `${(prob * 100).toFixed(1)}%`
                : "—";
              const closeDate = fresh?.close_date ?? match.close_date ?? null;
              const volume = fresh?.volume ?? null;
              const isExpired = closeDate !== null && new Date(closeDate).getTime() < Date.now();

              return (
                <li key={platform} className="modal-platform-row">
                  <span className="modal-platform-dot" style={{ background: color }} aria-hidden="true" />
                  <div className="modal-platform-info">
                    <div className="modal-platform-name-row">
                      <span className="modal-platform-name" style={{ color }}>{displayName}</span>
                      {closeDate && !isExpired && (
                        <span className="modal-platform-meta">closes {formatCloseDate(closeDate)}</span>
                      )}
                    </div>
                    {match.market_title && (
                      <span className="modal-platform-title" title={match.market_title}>{match.market_title}</span>
                    )}
                    {volume !== null ? (
                      <span className="modal-platform-meta modal-platform-volume">
                        {formatVolume(platform, volume)} volume
                      </span>
                    ) : platform === "manifold" && !loadingPrices ? (
                      <span className="modal-platform-meta modal-platform-volume modal-platform-mana">
                        Play money · Mana (not real USD)
                      </span>
                    ) : null}
                    {isEditingThis && (
                      <div className="modal-edit-platform-form" style={{ marginTop: "0.5rem" }}>
                        <p className="modal-edit-platform-instruction">{PLATFORM_URL_INSTRUCTIONS[platform]}</p>
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            type="url"
                            className="field-input"
                            style={{ flex: 1, minWidth: 0, fontSize: "0.875rem", padding: "0.375rem 0.5rem" }}
                            placeholder="Paste market URL…"
                            value={editUrl}
                            onChange={(e) => { setEditUrl(e.currentTarget.value); if (editError) setEditError(""); }}
                            disabled={editSaving}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                            onClick={() => handleSaveMatch(platform)}
                            disabled={editSaving || !editUrl.trim()}
                          >
                            {editSaving ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)" }}
                            onClick={() => { setEditingPlatform(null); setEditError(""); }}
                            disabled={editSaving}
                          >
                            Cancel
                          </button>
                        </div>
                        {editError && <p role="alert" className="field-error" style={{ marginTop: "0.25rem", fontSize: "0.8125rem" }}>{editError}</p>}
                      </div>
                    )}
                    {searchingPlatform === platform && !isEditingThis && (
                      <div style={{ marginTop: "0.5rem" }}>
                        <input
                          type="text"
                          className="field-input"
                          style={{ fontSize: "0.875rem", padding: "0.375rem 0.5rem", width: "100%" }}
                          placeholder={`Search ${displayName}…`}
                          value={platformSearchQuery}
                          onChange={(e) => setPlatformSearchQuery(e.currentTarget.value)}
                          autoFocus
                        />
                        {platformSearchLoading && (
                          <p className="platform-search-status">Searching…</p>
                        )}
                        {!platformSearchLoading && platformSearchResults.length === 0 && platformSearchQuery.trim().length >= 2 && (
                          <p className="platform-search-status">No results</p>
                        )}
                        {platformSearchResults.length > 0 && (
                          <ul style={{ listStyle: "none", margin: "0.25rem 0 0", padding: 0 }}>
                            {platformSearchResults.slice(0, 5).map((r) => (
                              <li key={r.market_id}>
                                <button
                                  type="button"
                                  className="platform-search-result-btn"
                                  onClick={() => handleSelectPlatformSearchResult(platform, r)}
                                  disabled={editSaving}
                                >
                                  <span className="platform-search-result-title">{r.market_title}</span>
                                  {r.implied_yes_prob !== null && (
                                    <span className="platform-search-result-prob">
                                      {(r.implied_yes_prob * 100).toFixed(1)}%
                                    </span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <button
                          type="button"
                          className="platform-search-cancel"
                          onClick={() => { setSearchingPlatform(null); setPlatformSearchQuery(""); setPlatformSearchResults([]); }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="modal-platform-right">
                    {!isEditingThis && (
                      <div className="modal-platform-actions">
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Re-search ${displayName} for this question`}
                          onClick={() => handleRematchPlatform(platform)}
                          title={`Re-search ${displayName}`}
                          disabled={rematchingPlatform === platform}
                        >
                          {rematchingPlatform === platform
                            ? <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(0,0,0,0.2)", borderTopColor: "currentColor" }} />
                            : "↻"}
                        </button>
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Override ${displayName} market link`}
                          onClick={() => { setEditingPlatform(platform); setEditUrl(""); setEditError(""); setSearchingPlatform(null); }}
                          title={`Override ${displayName} market`}
                        >
                          ✏
                        </button>
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Search ${displayName} for a different market`}
                          title={`Search ${displayName}`}
                          onClick={() => {
                            setSearchingPlatform(platform);
                            setPlatformSearchQuery("");
                            setPlatformSearchResults([]);
                            setEditingPlatform(null);
                          }}
                          style={searchingPlatform === platform ? { color: "var(--color-accent, #60a5fa)" } : undefined}
                        >
                          🔍
                        </button>
                        <button
                          type="button"
                          className="modal-edit-platform-btn btn-ghost"
                          aria-label={`Remove ${displayName} match`}
                          title={`Remove ${displayName} match`}
                          onClick={() => handleDeleteMatch(platform)}
                          disabled={deletingPlatform === platform}
                          style={{ color: "var(--color-error-text, #f87171)" }}
                        >
                          {deletingPlatform === platform
                            ? <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(0,0,0,0.2)", borderTopColor: "currentColor" }} />
                            : "×"}
                        </button>
                      </div>
                    )}
                    <span className={`modal-platform-prob${isRefreshing ? " modal-platform-prob--loading" : ""}`}>
                      {probDisplay}
                    </span>
                    {isRefreshing && <span className="modal-live-badge modal-live-badge--loading">…</span>}
                    {!isRefreshing && isExpired && (
                      <span className="modal-platform-expired-badge">EXPIRED</span>
                    )}
                    {!isRefreshing && !isExpired && fresh !== undefined && (
                      <span className="modal-live-badge">live</span>
                    )}
                    {match.market_url && (
                      <a
                        href={match.market_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="modal-platform-link btn-ghost"
                        aria-label={`Open ${displayName} market (opens in new tab)`}
                      >
                        ↗
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Arbitrage calculator */}
        <div className="modal-section modal-arb">
          <p className="modal-section-label">Arbitrage Calculator</p>

          {/* While the very first fetch is in flight and there are no cached prices, show nothing */}
          {loadingPrices && arbPlatformProbs.length < 2 ? null : arbMin && arbMax && arbCost !== null && arbProfit !== null && arbReturn !== null ? (
            <>
              {/* Trade steps */}
              <div className="arb-trade">
                <div className="arb-trade-row">
                  <span className="arb-step">①</span>
                  <span className="arb-action">Buy YES on</span>
                  <span className="arb-platform" style={{ color: PLATFORM_COLORS[arbMin.platform] }}>
                    {PLATFORM_DISPLAY[arbMin.platform]}
                  </span>
                  {arbMin.match.market_url && (
                    <a href={arbMin.match.market_url} target="_blank" rel="noopener noreferrer"
                      className="btn-ghost arb-link" aria-label={`Open ${PLATFORM_DISPLAY[arbMin.platform]}`}>↗</a>
                  )}
                  <span className="arb-price">{(arbMin.prob * 100).toFixed(1)}¢</span>
                </div>
                <div className="arb-trade-row">
                  <span className="arb-step">②</span>
                  <span className="arb-action">Buy NO on</span>
                  <span className="arb-platform" style={{ color: PLATFORM_COLORS[arbMax.platform] }}>
                    {PLATFORM_DISPLAY[arbMax.platform]}
                  </span>
                  {arbMax.match.market_url && (
                    <a href={arbMax.match.market_url} target="_blank" rel="noopener noreferrer"
                      className="btn-ghost arb-link" aria-label={`Open ${PLATFORM_DISPLAY[arbMax.platform]}`}>↗</a>
                  )}
                  <span className="arb-price">{((1 - arbMax.prob) * 100).toFixed(1)}¢</span>
                  <span className="arb-price-note">(100% − {(arbMax.prob * 100).toFixed(1)}%)</span>
                </div>

                <div className="arb-rule" />

                <div className="arb-summary-row">
                  <span className="arb-label">Combined cost</span>
                  <span className="arb-value">{(arbCost * 100).toFixed(1)}¢ per contract</span>
                </div>
                <div className="arb-summary-row">
                  <span className="arb-label">Guaranteed payout</span>
                  <span className="arb-value">100¢ (whichever side wins)</span>
                </div>
                <div className="arb-summary-row arb-profit-row">
                  <span className="arb-label">Profit</span>
                  <span className="arb-value arb-profit-value">
                    {(arbProfit * 100).toFixed(1)}¢ · {(arbReturn * 100).toFixed(1)}% return
                  </span>
                </div>
              </div>

              {/* Notional scaler */}
              <div className="arb-notional">
                <div className="arb-notional-row">
                  <label htmlFor="arb-notional-input" className="arb-notional-label">Scale to notional</label>
                  <div className="arb-notional-input-wrap">
                    <span className="arb-notional-currency">$</span>
                    <input
                      id="arb-notional-input"
                      type="number"
                      className="arb-notional-input"
                      value={calcNotional}
                      min={1}
                      max={1000000}
                      step={10}
                      onChange={(e) => setCalcNotional(Math.max(1, parseInt(e.target.value) || 100))}
                    />
                  </div>
                </div>
                <div className="arb-notional-breakdown">
                  <span>YES: <strong>${(arbMin.prob * calcNotional).toFixed(2)}</strong> on {PLATFORM_DISPLAY[arbMin.platform]}</span>
                  <span className="arb-notional-plus">+</span>
                  <span>NO: <strong>${((1 - arbMax.prob) * calcNotional).toFixed(2)}</strong> on {PLATFORM_DISPLAY[arbMax.platform]}</span>
                  <span className="arb-notional-equals">=</span>
                  <span>Profit: <strong className="arb-profit-value">${(arbProfit * calcNotional).toFixed(2)}</strong></span>
                </div>
              </div>

              {/* Caveats */}
              <div className="arb-caveats">
                {arbInvolvesPlayMoney && (
                  <p className="arb-caveat arb-caveat--warning">
                    ⚠ Manifold uses play money (Mana) — this spread cannot be arbitraged for real money.
                  </p>
                )}
                <p className="arb-caveat">
                  Assumes both markets resolve the same way. Fees, slippage, and withdrawal delays will reduce actual profit.
                </p>
              </div>
            </>
          ) : loadingPrices && arbPlatformProbs.length < 2 ? null : (
            <p className="arb-unavailable">
              {arbPlatformProbs.length < 2
                ? "Need prices from at least 2 matched platforms."
                : "Prices are too close to calculate a meaningful trade."}
            </p>
          )}
        </div>

        {/* Alert threshold */}
        <div className="modal-section modal-section--threshold">
          <p className="modal-section-label">Alert threshold</p>
          <ThresholdControl
            questionId={question.id}
            threshold={question.threshold}
            onThresholdChange={onThresholdChange}
          />
        </div>

        {/* Glossary */}
        <div className="modal-section modal-glossary">
          <button
            type="button"
            className="modal-glossary-toggle btn-ghost"
            onClick={() => setGlossaryOpen((v) => !v)}
            aria-expanded={glossaryOpen}
          >
            <span>What do these numbers mean?</span>
            <span aria-hidden="true">{glossaryOpen ? "▲" : "▼"}</span>
          </button>
          {glossaryOpen && (
            <dl className="modal-glossary-list">
              <div className="modal-glossary-item">
                <dt>YES probability (e.g. 17.4%)</dt>
                <dd>What the market collectively thinks is the chance this event happens. Traders buy and sell contracts worth $1 if the event occurs — the price they trade at is the implied probability. 17% means the crowd thinks there&apos;s a 17% chance.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>Spread (e.g. 12.4%)</dt>
                <dd>The gap between the highest and lowest YES probability across all platforms. A 12% spread means one platform prices the event at 5% and another at 17% — a significant disagreement. Bigger spread = more potential arbitrage opportunity.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>Volume (e.g. $8.7M)</dt>
                <dd>Total amount traded on this market. Higher volume means more traders have taken positions — prices are harder to move and generally more reliable. Low volume markets can have wide spreads just from lack of activity, not real disagreement.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>Closes in X (e.g. closes 8mo)</dt>
                <dd>When the market resolves and contracts pay out. A spread on a market closing in 2 days is very time-sensitive. One closing in 2 years gives more time for prices to converge naturally.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>LIVE badge</dt>
                <dd>This price was just fetched directly from the platform&apos;s API when you opened this panel. It reflects the current order book, not a cached value.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>↑ / ↓ arrow next to spread</dt>
                <dd>Whether the spread is growing (↑) or shrinking (↓) compared to the previous recorded value. A widening spread means platforms are diverging — a new signal may have hit one platform and not yet propagated to others.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>No market found</dt>
                <dd>This platform had no matching market when the question was added. Kalshi and some niche topics are harder to match automatically. The spread is still computed from the platforms that do have matches.</dd>
              </div>
              <div className="modal-glossary-item">
                <dt>Manifold volume (Mana)</dt>
                <dd>Manifold uses play money called Mana, not real USD. Its prices can be less reliable than Polymarket, Robinhood, or Kalshi because there&apos;s no financial consequence for being wrong. Large Manifold-vs-real-money spreads are common but not always pure arbitrage.</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WatchedRow component
// ---------------------------------------------------------------------------

interface WatchedRowProps {
  question: WatchedQuestion;
  onRemoveConfirmed: (id: string, queryText: string) => Promise<void>;
  isConfirmOpen: boolean;
  onRemoveClick: (id: string) => void;
  onCancelClick: (id: string) => void;
  removeButtonRef: (el: HTMLButtonElement | null) => void;
  onThresholdChange: (id: string, newThreshold: number | null) => void;
  onOpenDetail: (id: string) => void;
}

function WatchedRow({
  question,
  onRemoveConfirmed,
  isConfirmOpen,
  onRemoveClick,
  onCancelClick,
  removeButtonRef,
  onThresholdChange,
  onOpenDetail,
}: WatchedRowProps) {
  const confirmYesRef = useRef<HTMLButtonElement>(null);

  // Move focus to "Yes, remove" when confirmation opens
  useEffect(() => {
    if (isConfirmOpen) {
      confirmYesRef.current?.focus();
    }
  }, [isConfirmOpen]);

  const isFullyExpired = question.matches.length > 0 && question.matches.every((m) => {
    if (!m.close_date) return false;
    return new Date(m.close_date).getTime() < Date.now();
  });

  const rowClasses = [
    "watched-row",
    question.pending ? "watched-row--pending" : "",
    isFullyExpired ? "watched-row--expired" : "",
  ].filter(Boolean).join(" ");

  const spreadLevel = question.spread == null
    ? "cold"
    : question.spread > 0.03
      ? "hot"
      : question.spread >= 0.01
        ? "warm"
        : "cold";

  return (
    <li className={rowClasses} data-spread-level={spreadLevel}>
      <div className="watched-row-main">
        <button
          type="button"
          className="watched-query-text watched-query-text--btn"
          title={question.query_text}
          onClick={() => onOpenDetail(question.id)}
        >
          {question.query_text}
        </button>
        <div className="watched-row-meta">
          {question.pending ? (
            <span className="watched-row-pending-badge" aria-label="Adding market…">
              <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(0,0,0,0.15)", borderTopColor: "var(--color-text-muted)", width: "0.875em", height: "0.875em" }} />
              matching…
            </span>
          ) : isFullyExpired ? (
            <>
              <span className="watched-closed-badge" aria-label="All matched markets closed">CLOSED</span>
              <TimestampCell lastUpdated={question.last_updated} />
            </>
          ) : (
            <>
              <SpreadCell spread={question.spread} history={question.history} />
              <TimestampCell lastUpdated={question.last_updated} />
            </>
          )}
        </div>
      </div>

      <div className="watched-row-threshold">
        <ThresholdControl
          questionId={question.id}
          threshold={question.threshold}
          onThresholdChange={onThresholdChange}
        />
      </div>

      <div className="watched-row-sparkline">
        <Sparkline history={question.history} />
      </div>

      <div className="watched-row-bottom">
        <PlatformChips matches={question.matches} />

        {isConfirmOpen ? (
          /* Inline confirmation — only mounted when this row is being confirmed */
          <div
            role="group"
            aria-label={`Confirm removal of: ${question.query_text}`}
            className="watched-confirm-group"
          >
            <p className="watched-confirm-heading">Remove this question?</p>
            <p className="watched-confirm-body">You can always add it again later.</p>
            <div className="watched-confirm-actions">
              {/*
                "Yes, remove" is in a form whose action is the Server Action so
                it works even before JS hydration (pre-hydration form POST).
                After hydration, onSubmit intercepts and calls client DELETE.
              */}
              <form action={removeWatchedQuestionAction} onSubmit={(e) => {
                e.preventDefault();
                onRemoveConfirmed(question.id, question.query_text);
              }}>
                <input type="hidden" name="question_id" value={question.id} />
                <button
                  type="submit"
                  ref={confirmYesRef}
                  className="btn-danger watched-confirm-yes"
                >
                  Yes, remove
                </button>
              </form>
              <button
                type="button"
                onClick={() => onCancelClick(question.id)}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            ref={removeButtonRef}
            aria-label={`Remove question: ${question.query_text}`}
            className="watched-remove-btn btn-ghost"
            onClick={() => onRemoveClick(question.id)}
          >
            {REMOVE_BUTTON_LABEL}
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// SearchDropdown component
// ---------------------------------------------------------------------------

interface SearchDropdownProps {
  results: SearchResult[];
  isLoading: boolean;
  query: string;
  onSelect: (result: SearchResult, allResults: SearchResult[]) => void;
  listboxId: string;
}

function SearchDropdown({ results, isLoading, query, onSelect, listboxId }: SearchDropdownProps) {
  if (!query || query.length < 2) return null;

  // While re-fetching with existing results: keep showing them (stale-while-revalidate).
  // Only show the full loading spinner when there are no results yet.
  if (isLoading && results.length === 0) {
    return (
      <div className="search-dropdown" role="status" aria-live="polite">
        <div className="search-dropdown-loading">
          <span className="spinner" aria-hidden="true" />
          Searching markets…
        </div>
      </div>
    );
  }

  if (!isLoading && results.length === 0) {
    return (
      <div className="search-dropdown" role="status" aria-live="polite">
        <div className="search-dropdown-empty">No markets found for &ldquo;{query}&rdquo;</div>
      </div>
    );
  }

  // Group by platform
  const grouped = new Map<Platform, SearchResult[]>();
  for (const r of results) {
    if (!grouped.has(r.platform)) grouped.set(r.platform, []);
    grouped.get(r.platform)!.push(r);
  }

  return (
    <ul
      id={listboxId}
      role="listbox"
      aria-label="Market search results"
      className="search-dropdown"
    >
      {Array.from(grouped.entries()).map(([platform, platformResults]) => (
        <li key={platform} className="search-dropdown-group">
          <div
            className="search-dropdown-platform-label"
            style={{ color: PLATFORM_COLORS[platform] }}
          >
            {PLATFORM_DISPLAY[platform]}
          </div>
          <ul role="group" aria-label={PLATFORM_DISPLAY[platform]}>
            {platformResults.map((r) => {
              const prob = r.implied_yes_prob !== null
                ? `${(r.implied_yes_prob * 100).toFixed(0)}% YES`
                : null;
              return (
                <li key={`${r.platform}-${r.market_id}`} role="option" aria-selected="false">
                  <button
                    type="button"
                    className="search-result-btn"
                    onClick={() => onSelect(r, results)}
                  >
                    <span className="search-result-title">{r.market_title}</span>
                    {prob && (
                      <span className="search-result-prob">{prob}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// WatchedSection — main component
// ---------------------------------------------------------------------------

export default function WatchedSection({ initialQuestions }: WatchedSectionProps) {
  const router = useRouter();
  const [questions, setQuestions] = useState<WatchedQuestion[]>(initialQuestions);
  const [inputValue, setInputValue] = useState("");
  const [confirmRowId, setConfirmRowId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [rowError, setRowError] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [detailQuestionId, setDetailQuestionId] = useState<string | null>(null);

  // Auto-explore state
  const [exploreOpen, setExploreOpen] = useState(false);
  const [exploreJobId, setExploreJobId] = useState<string | null>(null);
  const [exploreStatus, setExploreStatus] = useState<"idle" | "loading" | "polling" | "done" | "error">("idle");
  const [exploreQuestions, setExploreQuestions] = useState<Array<{
    question_text: string;
    estimated_spread: number | null;
    matches: Array<{ platform: Platform; market_id: string; market_url: string | null; market_title: string; implied_yes_prob: number | null }>;
  }>>([]);
  const [exploreError, setExploreError] = useState("");
  const [exploreAdding, setExploreAdding] = useState<string | null>(null);
  const explorePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const removeButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  // Sync server-rendered questions into local state when the page refreshes
  useEffect(() => {
    setQuestions(initialQuestions);
  }, [initialQuestions]);

  // Server Action state (pre-hydration fallback — not used for live search flow)
  const [, addFormAction] = useActionState(addWatchedQuestionAction, null);

  const atCap = questions.length >= QUESTION_CAP;

  // Sort by spread descending, nulls last
  const sortedQuestions = useMemo(() =>
    [...questions].sort((a, b) => {
      if (a.spread === null && b.spread === null) return 0;
      if (a.spread === null) return 1;
      if (b.spread === null) return -1;
      return b.spread - a.spread;
    }),
    [questions]
  );

  // Debounced search
  useEffect(() => {
    const q = inputValue.trim();
    if (q.length < 2) {
      setShowDropdown(false);
      setSearchResults([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      // Cancel any in-flight request so stale results don't overwrite newer ones
      if (searchAbortRef.current) searchAbortRef.current.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;

      setSearchLoading(true);
      setShowDropdown(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          credentials: "include",
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { results?: SearchResult[]; error?: string };
        if (res.ok) {
          setSearchResults(data.results ?? []);
        } else {
          console.warn(`[search] API error ${res.status}:`, data.error ?? "unknown");
          setSearchResults([]);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return; // superseded by newer request
        setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputValue]);

  // Close dropdown on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Escape key: close dropdown or dismiss confirmation
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        if (showDropdown) {
          setShowDropdown(false);
          inputRef.current?.focus();
        } else if (confirmRowId) {
          const btn = removeButtonRefs.current.get(confirmRowId);
          setConfirmRowId(null);
          btn?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showDropdown, confirmRowId]);

  // Auto-explore: submit job then poll
  async function handleExplore() {
    setExploreOpen(true);
    setExploreStatus("loading");
    setExploreError("");
    setExploreQuestions([]);
    if (explorePollRef.current) clearTimeout(explorePollRef.current);
    try {
      const res = await fetch("/api/explore", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? "Failed to start explore");
      }
      const { jobId } = await res.json() as { jobId: string };
      setExploreJobId(jobId);
      setExploreStatus("polling");
      pollExploreJob(jobId);
    } catch (e) {
      setExploreStatus("error");
      setExploreError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  function pollExploreJob(jobId: string) {
    explorePollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/explore?jobId=${encodeURIComponent(jobId)}`, { credentials: "include" });
        if (!res.ok) throw new Error("Poll failed");
        const data = await res.json() as { status: string; questions?: typeof exploreQuestions };
        if (data.status === "completed") {
          setExploreQuestions(data.questions ?? []);
          setExploreStatus("done");
        } else if (data.status === "failed") {
          setExploreStatus("error");
          setExploreError("Explore job failed. Try again.");
        } else {
          // still pending/processing — keep polling
          pollExploreJob(jobId);
        }
      } catch {
        setExploreStatus("error");
        setExploreError("Lost connection while exploring. Try again.");
      }
    }, 10_000);
  }

  function handleCloseExplore() {
    setExploreOpen(false);
    setExploreStatus("idle");
    setExploreJobId(null);
    setExploreQuestions([]);
    setExploreError("");
    if (explorePollRef.current) clearTimeout(explorePollRef.current);
  }

  async function handleAddExploreQuestion(opp: { question_text: string; matches: Array<{ platform: Platform; market_id: string; market_url: string | null; market_title: string; implied_yes_prob: number | null }> }) {
    setExploreAdding(opp.question_text);
    try {
      const res = await fetch("/api/watched", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query_text: opp.question_text, pre_matches: opp.matches }),
      });
      if (res.ok) {
        const data = await res.json() as {
          id: string;
          query_text: string;
          created_at: number;
          spread: number | null;
          matches: PlatformMatch[];
        };

        // Add immediately so the card appears
        const newQuestion: WatchedQuestion = {
          id: data.id,
          query_text: data.query_text,
          created_at: data.created_at,
          spread: data.spread,
          last_updated: null,
          threshold: null,
          matches: data.matches ?? [],
          history: [],
          pending: false,
        };
        setQuestions((prev) => [...prev, newQuestion]);
        handleCloseExplore();

        // Fetch live prices in the background and update the card
        fetch(`/api/watched/${data.id}/prices`, { credentials: "include" })
          .then((r) => r.ok ? r.json() as Promise<{ prices: Array<{ platform: string; implied_yes_prob: number | null; close_date: string | null }> }> : null)
          .then((priceData) => {
            if (!priceData) return;
            const priceMap = new Map(priceData.prices.map((p) => [p.platform, p]));
            const updatedMatches = newQuestion.matches.map((m) => {
              const fresh = priceMap.get(m.platform);
              if (!fresh) return m;
              return { ...m, implied_yes_prob: fresh.implied_yes_prob ?? m.implied_yes_prob, close_date: fresh.close_date ?? m.close_date };
            });
            const probs = updatedMatches.map((m) => m.implied_yes_prob).filter((p): p is number => p !== null);
            const newSpread = probs.length >= 2 ? Math.max(...probs) - Math.min(...probs) : null;
            setQuestions((prev) => prev.map((q) =>
              q.id === data.id
                ? { ...q, matches: updatedMatches, spread: newSpread, last_updated: Math.floor(Date.now() / 1000) }
                : q
            ));
          })
          .catch(() => { /* best-effort */ });
      } else {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setExploreError(d.error ?? "Failed to add question.");
      }
    } catch {
      setExploreError("Network error. Try again.");
    } finally {
      setExploreAdding(null);
    }
  }

  // Add a market selected from search results (optimistic — shows card immediately)
  function handleSelectResult(result: SearchResult, allResults: SearchResult[]) {
    if (atCap) return;
    setFormError("");

    // Use the selected market's title as the query_text
    const queryText = result.market_title;

    // Always use the clicked result for its own platform; first result for others.
    const seenPlatforms = new Set<string>([result.platform]);
    const preMatches = [
      {
        platform: result.platform,
        market_id: result.market_id,
        market_title: result.market_title,
        market_url: result.market_url,
        implied_yes_prob: result.implied_yes_prob,
      },
      ...allResults
        .filter((r) => { if (seenPlatforms.has(r.platform)) return false; seenPlatforms.add(r.platform); return true; })
        .map((r) => ({
          platform: r.platform,
          market_id: r.market_id,
          market_title: r.market_title,
          market_url: r.market_url,
          implied_yes_prob: r.implied_yes_prob,
        })),
    ];

    // Build match list for immediate UI feedback
    const matchList: PlatformMatch[] = preMatches
      .filter((m) => m.market_id)
      .map((m) => ({ platform: m.platform as Platform, market_id: m.market_id, market_url: m.market_url, market_title: m.market_title, implied_yes_prob: m.implied_yes_prob }));

    // Create temp optimistic card
    const tempId = `pending-${Date.now()}`;
    const optimisticQ: WatchedQuestion = {
      id: tempId,
      query_text: queryText,
      created_at: Math.floor(Date.now() / 1000),
      spread: null,
      last_updated: null,
      matches: matchList,
      threshold: null,
      history: [],
      pending: true,
    };

    // Show optimistic card immediately
    setQuestions((prev) => [...prev, optimisticQ]);
    setInputValue("");
    setSearchResults([]);
    setShowDropdown(false);

    // Fire POST in background — no await
    (async () => {
      try {
        const res = await fetch("/api/watched", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ query_text: queryText, pre_matches: preMatches }),
        });

        if (res.ok) {
          const data = (await res.json()) as { id: string; query_text: string; created_at: number; spread?: number | null };
          const realMatchList: PlatformMatch[] = preMatches
            .filter((m) => m.market_id)
            .map((m) => ({ platform: m.platform as Platform, market_id: m.market_id, market_url: m.market_url, market_title: m.market_title, implied_yes_prob: m.implied_yes_prob }));
          const realQ: WatchedQuestion = {
            id: data.id,
            query_text: data.query_text,
            created_at: data.created_at,
            spread: data.spread ?? null,
            last_updated: data.spread != null ? Date.now() : null,
            matches: realMatchList,
            threshold: null,
            history: [],
            pending: false,
          };
          setQuestions((prev) => prev.map((q) => q.id === tempId ? realQ : q));
        } else {
          setQuestions((prev) => prev.filter((q) => q.id !== tempId));
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const serverError = typeof body.error === "string" ? body.error : "";
          setFormError(serverError || "Couldn't add market. Try again.");
        }
      } catch {
        setQuestions((prev) => prev.filter((q) => q.id !== tempId));
        setFormError("Couldn't add market. Try again.");
      }
    })();
  }

  function handleRemoveClick(id: string) {
    setConfirmRowId(id);
    setRowError("");
  }

  function handleCancelClick(id: string) {
    setConfirmRowId(null);
    requestAnimationFrame(() => {
      removeButtonRefs.current.get(id)?.focus();
    });
  }

  const handleThresholdChange = useCallback(
    (id: string, newThreshold: number | null) => {
      setQuestions((prev) =>
        prev.map((q) => (q.id === id ? { ...q, threshold: newThreshold } : q))
      );
    },
    []
  );

  const handleMatchesChange = useCallback(
    (id: string, newMatches: PlatformMatch[]) => {
      setQuestions((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          const probs = newMatches
            .map((m) => m.implied_yes_prob)
            .filter((p): p is number => p !== null);
          const newSpread = probs.length >= 2
            ? Math.max(...probs) - Math.min(...probs)
            : q.spread;
          return { ...q, matches: newMatches, spread: newSpread };
        })
      );
    },
    []
  );

  const [refreshingAll, setRefreshingAll] = useState(false);

  const handleRefreshAll = useCallback(async () => {
    const live = questions.filter((q) => !q.pending && q.matches.length > 0);
    if (live.length === 0) return;
    setRefreshingAll(true);
    try {
      const results = await Promise.allSettled(
        live.map((q) =>
          fetch(`/api/watched/${q.id}/prices`, { credentials: "include" })
            .then((r) => r.ok ? r.json() as Promise<{ prices: Array<{ platform: string; implied_yes_prob: number | null; close_date: string | null }> }> : null)
            .then((data) => ({ id: q.id, prices: data?.prices ?? [] }))
        )
      );
      setQuestions((prev) =>
        prev.map((q) => {
          const result = results.find(
            (r) => r.status === "fulfilled" && r.value.id === q.id
          );
          if (!result || result.status !== "fulfilled") return q;
          const priceMap = new Map(result.value.prices.map((p) => [p.platform, p]));
          const updatedMatches = q.matches.map((m) => {
            const fresh = priceMap.get(m.platform);
            if (!fresh) return m;
            return {
              ...m,
              implied_yes_prob: fresh.implied_yes_prob ?? m.implied_yes_prob,
              close_date: fresh.close_date ?? m.close_date,
            };
          });
          const probs = updatedMatches
            .map((m) => m.implied_yes_prob)
            .filter((p): p is number => p !== null);
          const newSpread = probs.length >= 2
            ? Math.max(...probs) - Math.min(...probs)
            : q.spread;
          return { ...q, matches: updatedMatches, spread: newSpread, last_updated: Math.floor(Date.now() / 1000) };
        })
      );
    } finally {
      setRefreshingAll(false);
    }
  }, [questions]);

  const handleRemoveConfirmed = useCallback(
    async (id: string, queryText: string) => {
      setConfirmRowId(null);

      try {
        const res = await fetch(`/api/watched/${id}`, {
          method: "DELETE",
          credentials: "include",
        });

        if (res.ok || res.status === 204 || res.status === 404) {
          setQuestions((prev) => {
            const idx = prev.findIndex((q) => q.id === id);
            const next = prev.filter((q) => q.id !== id);

            requestAnimationFrame(() => {
              if (next.length === 0) {
                inputRef.current?.focus();
              } else {
                const nextIdx = Math.min(idx, next.length - 1);
                const nextId = next[nextIdx]?.id;
                if (nextId) {
                  removeButtonRefs.current.get(nextId)?.focus();
                }
              }
            });

            return next;
          });
        } else {
          setRowError(`Couldn't remove "${queryText}". Try again in a moment.`);
        }
      } catch {
        setRowError(`Couldn't remove "${queryText}". Try again in a moment.`);
      }
    },
    []
  );

  const count = questions.length;
  const showCapMessage = atCap;

  return (
    <>
      {/* Page header with counter */}
      <header className="dashboard-header">
        <h1>Watched markets</h1>
        <div className="dashboard-header-right">
          {questions.some((q) => !q.pending && q.matches.length > 0) && (
            <button
              type="button"
              className="btn-ghost dashboard-refresh-btn"
              onClick={handleRefreshAll}
              disabled={refreshingAll}
              aria-label="Refresh prices for all watched markets"
              title="Fetch latest prices for all markets"
            >
              {refreshingAll
                ? <><span className="spinner" aria-hidden="true" />Refreshing…</>
                : "⟳ Refresh prices"}
            </button>
          )}
          <span
            aria-label={`${count} of 5 markets watched`}
            aria-live="polite"
            className={`dashboard-counter${count >= QUESTION_CAP ? " dashboard-counter--cap" : ""}`}
          >
            {count} / 5 watched
          </span>
        </div>
      </header>

      {/* Search form */}
      <section aria-label="Search and add a market">
        <div ref={searchContainerRef} className="search-container">
          <form
            id="add-question-form"
            className="add-question-form"
            action={addFormAction}
            onSubmit={(e) => e.preventDefault()}
            noValidate
          >
            <label htmlFor="question-input" className="sr-only">
              {INPUT_LABEL}
            </label>
            <div className="search-input-wrap">
              <span className="search-prompt" aria-hidden="true">&gt;_</span>
              <input
                ref={inputRef}
                id="question-input"
                name="query_text"
                type="text"
                autoComplete="off"
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.currentTarget.value);
                  if (formError) setFormError("");
                }}
                onFocus={() => {
                  if (inputValue.trim().length >= 2) setShowDropdown(true);
                }}
                placeholder="Search markets, e.g. Fed rate cut"
                maxLength={MAX_QUERY_TEXT_LENGTH}
                disabled={atCap}
                aria-disabled={atCap ? "true" : undefined}
                aria-autocomplete="list"
                aria-controls="search-listbox"
                aria-expanded={showDropdown ? "true" : "false"}
                className="field-input"
              />
            </div>
          </form>

          <button
            type="button"
            className="explore-btn"
            onClick={handleExplore}
            disabled={exploreStatus === "loading" || exploreStatus === "polling"}
            title="Auto-explore spread opportunities"
          >
            ✦ Explore
          </button>

          {showDropdown && !atCap && (
            <SearchDropdown
              listboxId="search-listbox"
              results={searchResults}
              isLoading={searchLoading}
              query={inputValue.trim()}
              onSelect={handleSelectResult}
            />
          )}
        </div>

        {showCapMessage && (
          <p id="cap-message" role="status" className="watched-cap-message">
            {CAP_EXCEEDED_MESSAGE}
          </p>
        )}

        {formError && (
          <p role="alert" className="field-error watched-form-error">
            {formError}
          </p>
        )}
      </section>

      {/* Auto-explore modal */}
      {exploreOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Explore spread opportunities">
          <div className="modal explore-modal">
            <div className="modal-header">
              <h2 className="modal-title">✦ Spread Opportunities</h2>
              <button type="button" className="modal-close btn-ghost" onClick={handleCloseExplore} aria-label="Close explore">×</button>
            </div>

            {(exploreStatus === "loading" || exploreStatus === "polling") && (
              <div className="explore-loading">
                <span className="spinner explore-spinner" aria-hidden="true" />
                <p className="explore-loading-text">
                  Searching the web for arbitrage opportunities…
                  <br />
                  <span className="explore-loading-sub">This takes about a minute.</span>
                </p>
              </div>
            )}

            {exploreStatus === "error" && (
              <div className="explore-error">
                <p>{exploreError}</p>
                <button type="button" className="btn-ghost" onClick={handleExplore}>Try again</button>
              </div>
            )}

            {exploreStatus === "done" && (
              <div className="explore-results">
                {exploreQuestions.length === 0 ? (
                  <p className="explore-empty">No opportunities found. Try again.</p>
                ) : (
                  <ul className="explore-list">
                    {exploreQuestions.map((opp) => (
                      <li key={opp.question_text} className="explore-item">
                        <div className="explore-item-body">
                          <p className="explore-item-text">{opp.question_text}</p>
                          <div className="explore-item-meta">
                            {opp.estimated_spread !== null && (
                              <span className="explore-item-spread">{(opp.estimated_spread * 100).toFixed(1)}% spread</span>
                            )}
                            <span className="explore-item-platforms">
                              {opp.matches.map((m) => m.platform).join(" · ")}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn-primary explore-item-add"
                          onClick={() => handleAddExploreQuestion(opp)}
                          disabled={exploreAdding === opp.question_text || atCap}
                          title={atCap ? "Question cap reached" : "Watch this question"}
                        >
                          {exploreAdding === opp.question_text
                            ? <span className="spinner" aria-hidden="true" style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
                            : "+ Watch"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Watched questions list */}
      <section aria-label="Your watched markets">
        {rowError && (
          <p role="alert" className="field-error watched-form-error">
            {rowError}
          </p>
        )}

        {questions.length === 0 ? (
          <div className="dashboard-empty-state">
            <p className="dashboard-empty-heading">{EMPTY_STATE_HEADING}</p>
            <p className="dashboard-empty-subtext">{EMPTY_STATE_SUBTEXT}</p>
          </div>
        ) : (
          <ul role="list" className="watched-list">
            {sortedQuestions.map((q) => (
              <WatchedRow
                key={q.id}
                question={q}
                isConfirmOpen={confirmRowId === q.id}
                onRemoveClick={handleRemoveClick}
                onRemoveConfirmed={handleRemoveConfirmed}
                onCancelClick={handleCancelClick}
                onThresholdChange={handleThresholdChange}
                onOpenDetail={setDetailQuestionId}
                removeButtonRef={(el) => {
                  if (el) {
                    removeButtonRefs.current.set(q.id, el);
                  } else {
                    removeButtonRefs.current.delete(q.id);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Detail modal */}
      {detailQuestionId && (() => {
        const q = questions.find((x) => x.id === detailQuestionId);
        if (!q) return null;
        return (
          <QuestionDetailModal
            question={q}
            onClose={() => setDetailQuestionId(null)}
            onThresholdChange={handleThresholdChange}
            onMatchesChange={handleMatchesChange}
          />
        );
      })()}
    </>
  );
}
