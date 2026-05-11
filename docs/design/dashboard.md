# Dashboard UX Spec

**Feature slug:** dashboard  
**Phase:** phase-1-mvp  
**Story:** story-dashboard-design  
**Status:** draft — sprint 1

**Cross-references:**
- `docs/design/auth-and-onboarding.md` — the onboarding flow that deposits the user here for the first time (flow 2A step 15; flow 2H for the quota-exhausted key-error banner originating post-onboarding).
- ADR-0002 (Wire error taxonomy) — defines the canonical error codes `key-missing`, `key-invalid`, and `quota-exhausted` used throughout this spec. ADR-0002 has not been published as of sprint 1; the error code strings and semantics used here are taken from the onboarding spec (§5D) and must be reconciled with ADR-0002 when it is written. Leave a `<!-- TODO: sync with ADR-0002 -->` comment wherever these codes appear in frontend code.
- ADR-0001 (`docs/architecture/0001-stack.md`) — establishes the 5-minute Vercel Cron cadence driving spread freshness and the `anakin_key_status` column used by the key-error banner logic.

---

## 1. User Intent

The user wants to monitor arbitrage spreads across prediction-market platforms for the specific questions they care about, and to be alerted when a spread crosses the threshold worth acting on.

---

## 2. Flow

### 2A. Happy-path: First visit (empty state)

```
1.  User arrives from /onboarding/key after successful key save.
    (See auth-and-onboarding.md §2A step 14–15.)
2.  /dashboard renders the empty watched-questions state.
3.  A welcome toast appears at the top of the page for 5 seconds
    (copy from auth-and-onboarding.md §5E).
4.  User reads the "Add your first question" prompt.
5.  User clicks inside the question input field or tabs to it.
6.  User types a free-text query (e.g. "Fed cuts rates June").
7.  User clicks "Watch question" or presses Enter.
8.  The add-question row enters the pending state (spinner, row placeholder).
9.  Server runs market matching across all 4 platforms.
10. Server responds with the matched question record.
    a. ≥1 platform matched → row appears in the watched list with spread
       (or null spread if only 1 platform matched) and platform chips.
    b. 0 platforms matched → row appears with the "no markets matched" tag.
11. Question counter updates: "1 / 5 watched".
12. Input field clears and returns focus to the input.
```

### 2B. Adding subsequent questions (up to cap)

```
1.  User repeats flow 2A steps 5–12.
2.  At 5 watched questions, the input field and submit button both become
    disabled. The counter reads "5 / 5 watched". A cap-reached inline
    message appears below the input.
3.  User cannot add more questions without first removing one.
```

### 2C. Removing a question

```
1.  User locates the question row they want to remove.
2.  User clicks the "Remove" button on that row (or activates it via keyboard).
3.  A confirmation prompt appears inline on the row:
    "Remove this question? You can add it again later."
    with two actions: "Yes, remove" and "Cancel".
4.  User confirms → row is removed with a brief fade-out animation.
    Counter decrements.
5.  If the list was at 5 / 5, the input field and submit button re-enable
    after the row is removed.
6.  User cancels → confirmation prompt dismisses; no change.
```

### 2D. Spread data refreshes (background)

```
1.  Every 5 minutes the Vercel Cron job refreshes spread data for all
    watched questions.
2.  When fresh data arrives, each row's spread value and last-updated
    timestamp update in place without a full page reload (client polls
    or uses server-sent events — implementation detail for the Frontend agent).
3.  If a spread crosses the > 3% threshold, the cell transitions to the
    alert-positive treatment.
4.  The last-updated timestamp for each row reflects the cron completion time,
    not the current time.
```

### 2E. Key-error discovered post-onboarding

```
1.  The cron job runs and discovers the user's key is invalid or exhausted.
2.  The server sets anakin_key_status to key-invalid or quota-exhausted.
3.  On the next dashboard load (or on the next data poll), the client
    receives the key-error state.
4.  The persistent key-error banner renders at the top of the page content
    area (below the nav, above the table).
5.  Spread values on all rows are frozen at their last known value.
    Last-updated timestamps stop advancing (they display the time of the
    last successful refresh).
6.  User reads the banner and clicks "Update key" → navigates to /settings/key.
7.  After the user saves a valid replacement key, the banner is cleared
    on the next successful cron run (or optimistically if the server probes
    the new key on save).
```

### 2F. Failure path: query submitted, slow network

```
1.  User submits a question.
2.  The server does not respond within 15 seconds.
3.  The pending-row spinner is replaced by an inline row error:
    "Matching timed out. Try adding the question again."
4.  The row is not persisted. A "Retry" button appears on the error row.
5.  User can click "Retry" (re-submits the same query) or dismiss the
    error row.
```

---

## 3. Layout

All layouts use a single-column centered page shell. Maximum content width is
a readable measure (implementation detail for the Frontend agent; somewhere
between 640 px and 960 px is typical). The page shell contains, top to bottom:

```
┌──────────────────────────────────────────────────────────────────┐
│  NAV BAR                                                         │
│  [App wordmark / logo]                  [Settings]  [Sign out]   │
├──────────────────────────────────────────────────────────────────┤
│  KEY-ERROR BANNER (conditionally rendered — see §8)              │
│  [!] "Wire calls paused" — [body copy]          [Update key →]   │
├──────────────────────────────────────────────────────────────────┤
│  PAGE HEADER                                                      │
│  h1: "Watched questions"           counter: "N / 5 watched"      │
├──────────────────────────────────────────────────────────────────┤
│  DISCLAIMER SUB-HEADER (always visible when table is rendered)   │
│  "arb ≠ profit; slippage and fees may eat spread"                │
├──────────────────────────────────────────────────────────────────┤
│  ADD-QUESTION ROW                                                 │
│  [________________________________] [Watch question]             │
│  (free-text input)                  (submit button)              │
│  (inline cap message or inline pending/error — conditional)      │
├──────────────────────────────────────────────────────────────────┤
│  WATCHED-QUESTIONS TABLE / LIST                                   │
│  (see per-state layouts below)                                    │
├──────────────────────────────────────────────────────────────────┤
│  FOOTER                                                           │
│  "arb ≠ profit; slippage and fees may eat spread"                │
│  "Spread data refreshes every 5 minutes."                        │
└──────────────────────────────────────────────────────────────────┘
```

### Disclaimer placement rule

The disclaimer string "arb ≠ profit; slippage and fees may eat spread" appears
in two fixed locations on every view that renders spread values:

1. **Disclaimer sub-header:** Immediately below the page `<h1>`, above the
   add-question row. Rendered as a `<p>` in the body-small typographic scale
   (one step smaller than the page `<h1>` companion text, two steps smaller
   than the spread value). This position ensures the disclaimer is visible
   before the user reads any spread number.
2. **Footer:** The last line of the page footer, in the caption/footnote
   typographic scale (smallest readable body text). This position ensures the
   disclaimer is visible after the user has scrolled through all spread rows.

On the empty state (no watched questions, no spreads), both disclaimer
locations are still rendered. They are never hidden or conditionally removed.

### Watched-questions table row anatomy (populated state)

Each row in the watched-questions list has this internal structure:

```
┌──────────────────────────────────────────────────────────────────┐
│ QUERY TEXT                         SPREAD        LAST UPDATED    │
│ "Fed cuts rates June"              4.2%          3 min ago       │
│                                                                  │
│ [Kalshi ↗] [Manifold ↗] [Polymarket ↗] [Robinhood —]           │
│                                          (no-match chip)         │
│                                                       [Remove]   │
└──────────────────────────────────────────────────────────────────┘
```

Column / region breakdown:

- **Query text:** Left-aligned, full-width on small screens; takes remaining
  width on wide screens. The free-text query the user typed. Truncated at two
  lines with an ellipsis if longer.
- **Spread value:** Right-aligned on wide screens; below query text on narrow
  screens. Typographic scale: the spread number is rendered one step larger
  than the query text (body-large or numeric-display treatment). Color
  treatment rules are specified in §6 (Color / Treatment Rules).
- **Last-updated timestamp:** Adjacent to the spread value (below it or to
  its right, depending on breakpoint). Rendered in caption/muted scale.
  Freshness treatment rules are specified in §6.
- **Platform chips:** A horizontal strip of four chips, one per platform
  (Kalshi, Manifold, Polymarket, Robinhood), always rendered in this order.
  - Matched chip: name + external-link icon, rendered as an `<a>` to the
    platform market page. `aria-label="View on Kalshi (opens in new tab)"`.
  - No-match chip: name only, greyed out, `aria-disabled="true"`, no link,
    `aria-label="Not matched on Robinhood"`.
- **Remove button:** Right-aligned, below the platform chips. Button label:
  "Remove". Renders inline confirmation on activation (see §2C).

### Component hierarchy

```
<main aria-label="Watched questions dashboard">
  <div role="alert" aria-live="assertive" aria-atomic="true" id="key-error-banner">
    <!-- conditionally populated; see §8 -->
  </div>

  <header>
    <h1>Watched questions</h1>
    <span aria-label="N of 5 questions watched">N / 5 watched</span>
  </header>

  <p id="spread-disclaimer" class="disclaimer">
    arb ≠ profit; slippage and fees may eat spread
  </p>

  <section aria-label="Add a question">
    <form id="add-question-form">
      <label for="question-input">Watch a new question</label>
      <input id="question-input" type="text" … />
      <button type="submit">Watch question</button>
      <!-- conditional: cap message, pending indicator, or error message -->
    </form>
  </section>

  <section aria-label="Your watched questions">
    <ul role="list">          <!-- or <table> — see §7 Accessibility note -->
      <li>…row…</li>
      …
    </ul>
  </section>

  <footer>
    <p>arb ≠ profit; slippage and fees may eat spread</p>
    <p>Spread data refreshes every 5 minutes.</p>
  </footer>
</main>
```

---

## 4. States

### State 1 — Empty state

User just finished onboarding: 0 watched questions.

```
┌──────────────────────────────────────────────────────────────────┐
│  NAV BAR                                                         │
├──────────────────────────────────────────────────────────────────┤
│  h1: "Watched questions"                     "0 / 5 watched"     │
├──────────────────────────────────────────────────────────────────┤
│  "arb ≠ profit; slippage and fees may eat spread"                │
├──────────────────────────────────────────────────────────────────┤
│  [________________________________] [Watch question]             │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  "You're not watching any questions yet."                  │  │
│  │  "Type a question above to start tracking spreads."        │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  FOOTER: disclaimer + refresh note                               │
└──────────────────────────────────────────────────────────────────┘
```

- The welcome toast ("You're all set. Start watching your first question below.")
  appears for 5 seconds and auto-dismisses (`role="status"`).
- The question input has `autofocus` on mount (applied after the toast renders;
  use a single `requestAnimationFrame` delay if the toast disrupts focus).
- The empty-state illustration area (the box above) may use a simple decorative
  SVG or just the two lines of copy; the Frontend agent chooses. If an
  illustration is used, it must have `aria-hidden="true"`.
- The add-question form is fully enabled: input enabled, button enabled.
- The "0 / 5 watched" counter is visible.

### State 2 — Loading state

Page has mounted; the user's watched questions are known (from the server or
local cache) but the latest spread data is still being fetched from the cron
endpoint or a manual refresh.

```
┌──────────────────────────────────────────────────────────────────┐
│  NAV BAR                                                         │
├──────────────────────────────────────────────────────────────────┤
│  h1: "Watched questions"                     "N / 5 watched"     │
├──────────────────────────────────────────────────────────────────┤
│  "arb ≠ profit; slippage and fees may eat spread"                │
├──────────────────────────────────────────────────────────────────┤
│  [________________________________] [Watch question]             │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ [████████████████]  [░░░░░░]  [░░░░░░░░░]               │    │
│  │  (skeleton query)  (spread) (timestamp)                  │    │
│  │ [░░░░░] [░░░░░] [░░░░░] [░░░░░]   [░░░░░░]              │    │
│  │  (platform chips — skeleton)      (remove skeleton)     │    │
│  ├──────────────────────────────────────────────────────────┤    │
│  │  … repeat for each known watched question …              │    │
│  └──────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│  FOOTER                                                          │
└──────────────────────────────────────────────────────────────────┘
```

- Skeleton rows (shimmer animation) are rendered for each watched question
  whose spread data has not yet arrived. The query text may be shown (it is
  already known from persistent storage) while only the spread and timestamp
  are skeletonized.
- The query text being visible during loading reduces perceived latency.
- The add-question form is enabled during loading (user can type a query;
  submission is allowed and queues normally).
- The counter reflects the known number of watched questions.
- `aria-busy="true"` is set on the `<section aria-label="Your watched questions">`
  during loading and removed when data is ready.
- A visually-hidden live region announces "Spread data loaded" when the loading
  state resolves, so screen-reader users know the page has updated.

### State 3 — Populated state

1–5 watched questions, spread data available, all fresh (last_updated ≤ 10 min).

```
┌──────────────────────────────────────────────────────────────────┐
│  NAV BAR                                                         │
├──────────────────────────────────────────────────────────────────┤
│  h1: "Watched questions"                     "3 / 5 watched"     │
├──────────────────────────────────────────────────────────────────┤
│  "arb ≠ profit; slippage and fees may eat spread"                │
├──────────────────────────────────────────────────────────────────┤
│  [________________________________] [Watch question]             │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ "Fed cuts rates June"              4.2%      3 min ago   │    │
│  │ [Kalshi ↗] [Manifold ↗] [Polymarket ↗] [Robinhood —]   │    │
│  │                                               [Remove]   │    │
│  ├──────────────────────────────────────────────────────────┤    │
│  │ "Will BTC hit 100k by EOY"         1.1%      1 min ago   │    │
│  │ [Kalshi ↗] [Manifold ↗] [Polymarket —] [Robinhood ↗]   │    │
│  │                                               [Remove]   │    │
│  ├──────────────────────────────────────────────────────────┤    │
│  │ "Election winner Arizona"            —%      5 min ago   │    │
│  │  (null spread: only 1 platform matched)                  │    │
│  │ [Kalshi —] [Manifold ↗] [Polymarket —] [Robinhood —]   │    │
│  │                                               [Remove]   │    │
│  └──────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│  FOOTER                                                          │
└──────────────────────────────────────────────────────────────────┘
```

- Add-question form is enabled; submit button enabled.
- Each row renders query text, spread, timestamp, platform chips, and Remove.
- Color treatment on spread values follows §6.
- Null spread (only one platform matched) renders as "—" in the
  disabled-text treatment (see §6).

### State 4 — Cap-reached state

5 watched questions; add control is disabled.

```
┌──────────────────────────────────────────────────────────────────┐
│  …                                                               │
│  h1: "Watched questions"                     "5 / 5 watched"     │
│  "arb ≠ profit; slippage and fees may eat spread"                │
│                                                                  │
│  [________________________________] [Watch question — disabled]  │
│  "You've reached the 5-question limit. Remove a question         │
│   to add a new one."                                             │
│                                                                  │
│  [… 5 question rows …]                                           │
└──────────────────────────────────────────────────────────────────┘
```

- The question input is `disabled` (greyed, not interactive).
- The "Watch question" submit button is `disabled`.
  - Both have `aria-disabled="true"` so assistive technology reads the
    disabled state rather than omitting the controls entirely.
  - The input has `aria-describedby="cap-message"`.
- The inline cap message ("You've reached the 5-question limit. Remove a
  question to add a new one.") renders immediately below the input/button row
  in a `<p id="cap-message">`. It is not a `role="alert"` because the user
  has actively hit the cap — it is informational, not an error.
- The counter reads "5 / 5 watched" and is styled with the attention/warning
  treatment (see §6) to signal the cap without being alarming.

### State 5 — Stale data state

One or more rows have last_updated > 10 minutes ago. This indicates the cron
missed at least two cycles (expected cadence is 5 min).

```
│ "Fed cuts rates June"              4.2%      14 min ago ⚠        │
│ [Kalshi ↗] [Manifold ↗] [Polymarket ↗] [Robinhood —]            │
│                                                        [Remove]  │
```

- Rows with last_updated > 10 min render the timestamp in the
  warning/attention treatment (see §6) with a warning glyph (or equivalent
  visual indicator; not emoji in production code unless the Frontend agent
  uses a proper icon component) appended after the timestamp.
- The spread value itself is not greyed out — it retains its normal color
  treatment because the value is still valid; only its freshness is uncertain.
- No page-level banner appears for stale data alone. The staleness indicator
  is row-level only, unless a key-error state is also active.
- `aria-label` on the timestamp element reads:
  "Last updated 14 minutes ago — data may be stale"
  (the "data may be stale" suffix is added only when > 10 min).
- Rows with last_updated ≤ 10 min render normally with no warning treatment.
  Rows with last_updated ≤ 5 min render the timestamp in the muted/secondary
  treatment (normal freshness).

### State 6A — Key-error: key-missing

This state should not occur post-onboarding (the onboarding gate requires a
key before the user reaches /dashboard), but it is covered defensively.

**Banner (top of content area, above h1):**

```
┌─────────────────────────────────────────────────────────────────┐
│ [!]  Wire calls paused                                          │
│      Add an Anakin key in Settings to start watching markets.   │
│                                               [Update key →]    │
└─────────────────────────────────────────────────────────────────┘
```

- The banner is persistent; it has no dismiss button.
- Spread data for all rows shows as "—" in the disabled-text treatment with
  `aria-label="Spread unavailable — no API key"`.
- Last-updated timestamps read "—" (no timestamp available).
- The add-question form is enabled (the user can still add questions; they
  just will not be matched until a key is provided).
- Platform chips render in the no-match (greyed) treatment for all rows
  because no matching has run.
- "Update key" link navigates to `/settings/key`.
- Banner is an `aria-live="assertive"` region (see §7 Accessibility).

### State 6B — Key-error: key-invalid

**Banner:**

```
┌─────────────────────────────────────────────────────────────────┐
│ [!]  Wire calls paused                                          │
│      Your Anakin key was rejected — paste a fresh one in        │
│      Settings.                                                  │
│                                               [Update key →]    │
└─────────────────────────────────────────────────────────────────┘
```

- Row-level effect: spread values are frozen at the last successful refresh
  value. The spread value retains its normal color treatment (because the value
  itself is still meaningful) but the last-updated timestamp is appended with
  "(paused)" to signal no new data is coming.
  Example timestamp: "2 hr ago (paused)".
  `aria-label` on the timestamp: "Last updated 2 hours ago, refreshes paused".
- All other row-level behavior is the same as State 6A above.

### State 6C — Key-error: quota-exhausted

**Banner:**

```
┌─────────────────────────────────────────────────────────────────┐
│ [!]  Wire calls paused                                          │
│      Your Anakin key has hit its quota — refreshes paused       │
│      until {cooldown_ends_at}.                                  │
│                                               [Update key →]    │
└─────────────────────────────────────────────────────────────────┘
```

- `{cooldown_ends_at}` is formatted as a human-readable absolute datetime in
  the user's local timezone: "Mon 12 May at 3:00 PM" (or the locale-appropriate
  equivalent). It is not rendered as a countdown.
  If `cooldown_ends_at` is not available from the server (Wire does not always
  return it), the copy falls back to:
  "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin
  account to resume."
- Row-level effect: same as State 6B (spreads frozen, timestamps show "(paused)").
- The "Update key" link navigates to `/settings/key` for users who wish to
  rotate to a key with remaining quota instead of waiting for the cooldown.

### State 7 — Add-question pending state

User has submitted a new query; the server is running market matching.

```
┌──────────────────────────────────────────────────────────────────┐
│  …header, disclaimer, add-question row (cleared, re-enabled)…   │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ [spinner] "Fed cuts rates June"       Matching…            │  │
│  │ [░░░░░] [░░░░░] [░░░░░] [░░░░░]                           │  │
│  │  (platform chips — skeleton while matching runs)           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [… existing question rows …]                                    │
└──────────────────────────────────────────────────────────────────┘
```

- The pending row is inserted at the top of the list immediately on submission,
  before the server responds. It is optimistic.
- The query text is shown verbatim in the pending row (user can see what they
  submitted).
- The spread cell shows "Matching…" in the muted/secondary treatment.
  `aria-label="Spread matching in progress"`.
- Platform chips are skeleton placeholders.
- There is no Remove button on the pending row. The row cannot be removed
  until matching completes.
- The question counter increments optimistically (e.g. "4 / 5 watched") as
  soon as the row is added. If the server returns an error, the counter
  reverts and the pending row transitions to the error state (see §2F).
- The add-question input field clears and refocuses after submission. If the
  user's submission would hit the cap (the pending row is the 5th), the form
  disables immediately; no new submissions are accepted until the pending row
  resolves.
- `aria-live="polite"` on the list container means the insertion of the
  pending row is announced to screen readers: the `aria-label` on the pending
  row item is "New question: Fed cuts rates June — matching in progress".

### State 8 — No-platforms-matched state

The query was submitted successfully, matching ran, but zero markets were
found across all 4 platforms.

```
┌──────────────────────────────────────────────────────────────────┐
│  …                                                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ "some very niche query"            —         5 min ago     │  │
│  │ No markets matched                                         │  │
│  │ [Kalshi —] [Manifold —] [Polymarket —] [Robinhood —]       │  │
│  │                                               [Remove]     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

- The row is permanently added to the list (the user chose to watch this
  query; it counts against the 5-question cap).
- The spread displays "—" in the disabled-text treatment.
- All four platform chips are in the no-match (greyed, no-link) state.
- A "No markets matched" tag appears below the query text. It is styled in the
  muted/secondary treatment, not as an error — it is an informational result.
- `aria-label` on the spread cell: "No spread — no markets matched this query".
- `aria-label` on the row's `<li>` or `<tr>`: "some very niche query — no
  markets matched".
- The Remove button is present and functional; the user may remove a
  no-match row to free up a slot.
- The cron will continue to attempt matching on subsequent runs in case new
  markets appear on any platform. If a match is found later, the row
  transitions to the normal spread state. No user action is needed.

---

## 5. Copy

### 5A. Page-level copy

- **Page `<title>`:** "Dashboard — ArbWatch"
- **`<h1>`:** "Watched questions"
- **Counter (aria-label):** "N of 5 questions watched" (screen-reader text);
  visible text: "N / 5 watched"
- **Disclaimer string (used in both sub-header and footer):**
  "arb ≠ profit; slippage and fees may eat spread"
- **Footer refresh note:** "Spread data refreshes every 5 minutes."

### 5B. Add-question form

- **Input label (visually hidden, not a visible placeholder):**
  "Watch a new question"
- **Input placeholder:** "e.g. Fed cuts rates June"
- **Submit button (idle):** "Watch question"
- **Submit button (loading, aria-label):** "Adding question…"
  (visible label changes to spinner with visually-hidden text "Adding question…")
- **Cap-reached inline message (below form, `id="cap-message"`):**
  "You've reached the 5-question limit. Remove a question to add a new one."
- **Add error — timeout (inline row error):**
  "Matching timed out. Try adding the question again."
- **Add error — generic server error (inline row error):**
  "Something went wrong. Try again in a moment."

### 5C. Watched-questions list

- **Empty-state heading:** "You're not watching any questions yet."
- **Empty-state subtext:** "Type a question above to start tracking spreads."
- **Pending row spread cell:** "Matching…"
- **Pending row aria-label pattern:**
  "New question: {query} — matching in progress"
- **Null spread (one platform matched):** "—"
  (no additional text; context provided by aria-label: "Spread unavailable —
  only one platform matched this question")
- **No-markets-matched tag:** "No markets matched"
- **No-markets-matched spread aria-label:**
  "No spread — no markets matched this query"
- **Remove button:** "Remove"
- **Remove button aria-label:** "Remove question: {query}"
- **Inline confirmation heading (on row, after Remove is clicked):**
  "Remove this question?"
- **Inline confirmation body:**
  "You can always add it again later."
- **Confirm action button:** "Yes, remove"
- **Cancel action button:** "Cancel"

### 5D. Platform chips

- **Chip with match (accessible label):** "View on {Platform} (opens in new tab)"
  — e.g. "View on Kalshi (opens in new tab)"
- **Chip without match (accessible label):** "Not matched on {Platform}"
  — e.g. "Not matched on Robinhood"
- **Visible chip text:** Platform name only — "Kalshi", "Manifold",
  "Polymarket", "Robinhood"
- **Matched chip external-link icon:** decorative `aria-hidden="true"`; the
  full accessible label is on the `<a>` element.

### 5E. Timestamps

- **Relative timestamp pattern (< 1 min):** "just now"
- **Relative timestamp pattern (1–59 min):** "N min ago" (e.g. "3 min ago")
- **Relative timestamp pattern (1–23 hr):** "N hr ago" (e.g. "2 hr ago")
- **Relative timestamp pattern (≥ 24 hr):** Absolute date "D Mon" (e.g. "10 May")
- **Stale suffix (> 10 min, added to the aria-label only):**
  "Last updated {relative time} — data may be stale"
- **Paused suffix (key-error state, visible):** "(paused)"
  Full example visible text: "2 hr ago (paused)"
  Full aria-label: "Last updated 2 hours ago, refreshes paused"

### 5F. Key-error banners

All three banners share the same heading and structure. Banner heading (bold):
"Wire calls paused"

- **key-missing body:**
  "Add an Anakin key in Settings to start watching markets."
- **key-invalid body:**
  "Your Anakin key was rejected — paste a fresh one in Settings."
- **quota-exhausted body (with cooldown):**
  "Your Anakin key has hit its quota — refreshes paused until {cooldown_ends_at}."
- **quota-exhausted body (no cooldown timestamp available):**
  "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin
  account at anakin.company/wire to resume."
- **Banner CTA link text:** "Update key"
- **Banner CTA aria-label:** "Update your Anakin key in Settings"
- **Banner icon aria-label (the [!] indicator):** "Error"

  Note: The banner copy above supersedes the draft copy in
  auth-and-onboarding.md §5D, which should be treated as a placeholder.
  The strings here are final.

### 5G. Loading and skeleton states

- **`aria-busy` live announcement (when data loads):**
  "Spread data loaded." (announced via visually-hidden `aria-live="polite"` span)
- **Skeleton row aria-label:** "Loading spread data for {query}" (where query
  is known) or "Loading watched question" (where the query text is not yet
  known from cache).

---

## 6. Color / Treatment Rules

These rules use semantic treatment names. The Frontend agent maps them to design
tokens.

### Spread value treatments

| Condition | Treatment name | Notes |
|---|---|---|
| spread > 3% (alert threshold) | `spread-alert` | Success-positive / green family. This is the "act on this" state. |
| 0% < spread ≤ 3% | `spread-neutral` | Normal body text color. No special emphasis. |
| spread = 0% | `spread-neutral` | Treat the same as above; zero is a valid spread. |
| spread = null (1 platform match) | `spread-unavailable` | Disabled-text / muted. Rendered as "—". |
| spread = null (0 platform matches) | `spread-unavailable` | Same treatment. Rendered as "—". |
| spread frozen (key-error) | Retain last-known treatment | The color reflects the last-known value; "(paused)" is added to the timestamp, not to the spread cell itself. |

The spread number itself is one typographic step larger than the query text
to give it visual hierarchy. It is never bolded solely to indicate an alert;
the color treatment is the primary signal. A secondary visual cue (e.g. a
subtle background tint on the spread cell) may be added by the Frontend agent
for users with color vision deficiencies, but must not rely on color alone as
the sole differentiator — the `aria-label` on the spread cell must encode the
semantic state (see §7 Accessibility).

### Last-updated timestamp treatments

| Condition | Treatment name | Notes |
|---|---|---|
| last_updated ≤ 5 min | `timestamp-fresh` | Muted / secondary color. No special attention needed. |
| 5 min < last_updated ≤ 10 min | `timestamp-aging` | Same muted treatment; no visual change. The cron runs every 5 min; this window is normal. |
| last_updated > 10 min | `timestamp-stale` | Warning / attention color. A warning icon is added. |
| Key-error state (any) | `timestamp-paused` | Muted. Appended with visible "(paused)" text. |

### Counter treatment

| Condition | Treatment name |
|---|---|
| 0–4 questions watched | `counter-normal` | Default body text. |
| 5 / 5 (cap reached) | `counter-cap` | Warning / attention color. |

### Banner treatment

All key-error banners use the `banner-error` treatment: a visually distinct
background (error/danger family) with sufficient contrast for the body text and
CTA link. The banner is full-width within the content area. It must not rely
solely on a colored border as the sole differentiator — both background and
text must distinguish it from normal content in both light and dark modes.

---

## 7. Keyboard and Accessibility

### 7A. Focus order on page load

1. Skip-to-main link (visually hidden until focused): "Skip to main content"
2. App wordmark / logo link (`aria-label="ArbWatch home"`)
3. Settings nav link
4. Sign out button
5. Key-error banner CTA link (if banner is present — focus is moved here
   programmatically on mount when a key-error state is active)
6. Question input (`autofocus` on mount when no key-error is active; otherwise
   focus moves to the banner CTA first, then the user tabs to the input)
7. "Watch question" submit button
8. For each watched-question row (in document order):
   a. Platform chip links (matched chips only; no-match chips are not
      focusable because they are not interactive)
   b. Remove button

### 7B. Keyboard interactions

| Element | Key | Behavior |
|---|---|---|
| Question input | `Enter` | Submits the add-question form |
| "Watch question" button | `Enter` / `Space` | Submits the add-question form |
| Platform chip link | `Enter` | Opens the platform market page in a new tab |
| "Remove" button | `Enter` / `Space` | Opens the inline confirmation prompt |
| "Yes, remove" button | `Enter` / `Space` | Confirms removal; focus returns to the question input |
| "Cancel" button | `Enter` / `Space` | Dismisses confirmation; focus returns to the "Remove" button for that row |
| `Escape` (anywhere on page) | `Escape` | Dismisses any open inline confirmation prompt |
| "Update key" banner link | `Enter` | Navigates to /settings/key |

When a question row is removed, focus must not be left stranded. After removal:
- If there are remaining rows, focus moves to the Remove button of the next row.
- If the removed row was the last, focus moves to the question input.

### 7C. Table vs. list semantics

The watched-questions collection is rendered as `<ul role="list">` with
`<li>` items, not as an HTML `<table>`. Rationale: the rows are not tabular
data with column headers that apply across all rows; each row is a self-contained
unit. A list gives screen readers a natural "N items" count and allows the
grid-like visual layout via CSS without imposing table navigation semantics
(which would require `rowheader` / `columnheader` roles that do not map cleanly
to this structure).

If the Frontend agent has a strong reason to use `<table>`, the following
applies: `<thead>` with `<th scope="col">` for Query, Spread, Last Updated,
Platforms, and Actions; each data cell uses `<td>`; the Remove button cell is
`<td>` with `aria-label` that includes the query name for context. The table
must have `<caption>` "Watched questions".

### 7D. Screen-reader labels for spread values

Every spread value cell must have an `aria-label` that encodes the semantic
meaning, not just the raw number:

- spread > 3%:
  `aria-label="Spread: 4.2% — above alert threshold"`
- 0% < spread ≤ 3%:
  `aria-label="Spread: 1.1%"`
- null spread (1 platform match):
  `aria-label="Spread unavailable — only one platform matched this question"`
- null spread (0 platforms matched):
  `aria-label="No spread — no markets matched this query"`
- frozen spread (key-error):
  `aria-label="Spread: 4.2% — refreshes paused"`

### 7E. Key-error banner ARIA

The banner container:

```html
<div
  id="key-error-banner"
  role="alert"
  aria-live="assertive"
  aria-atomic="true"
  aria-label="API key error"
>
```

- `role="alert"` implies `aria-live="assertive"` but both are specified
  explicitly for clarity and browser compatibility.
- `aria-atomic="true"` ensures the entire banner is read when it appears or
  its content changes (e.g. switching from key-invalid to quota-exhausted).
- When no key error is active, the banner element remains in the DOM but is
  empty (not `display:none`) so the `aria-live` region is pre-registered with
  the accessibility tree. Content is injected into the element when an error
  occurs.
- The "Update key" link inside the banner has `aria-label="Update your Anakin
  key in Settings"` — the bare text "Update key" is ambiguous without the
  banner heading context for users who navigate by links.

### 7F. Inline confirmation (Remove flow)

When the inline confirmation prompt appears on a row:

- Focus is moved programmatically to the "Yes, remove" button (`tabIndex="-1"` +
  `.focus()`).
- The prompt is rendered inside the row's `<li>` element so screen readers
  announce it in context.
- The confirmation uses `role="group"` with `aria-label="Confirm removal of:
  {query}"` to group the two buttons semantically.

### 7G. Accessibility: color-only rule

Color alone must never be the sole means of conveying the spread alert state.
In addition to the `spread-alert` color treatment, the `aria-label` on the
spread cell includes "— above alert threshold" (see §7D). The Frontend agent
may also add a non-color cue (icon, bold weight, background tint) for
users with color vision deficiencies.

---

## 8. Edge Cases

### E1. Long query text

- The query text column truncates at two lines (`-webkit-line-clamp: 2` or
  equivalent) with a trailing ellipsis. The full text is preserved in the DOM
  as `title` attribute and as the accessible name of the row item.
- Platform chips wrap to a second line if there is insufficient horizontal
  space; they do not scroll horizontally.
- The spread value and timestamp are never truncated; if the layout cannot
  accommodate both on one line at a narrow viewport, the timestamp wraps below
  the spread value.

### E2. Very short or single-word query

- No minimum length is enforced in the UI. A single character is a valid query.
- Server-side matching may return no results; the row enters the
  no-platforms-matched state (State 8).

### E3. Duplicate query

- The UI does not prevent adding the same free-text query twice. If the user
  submits a query that already exists in their watched list, the server must
  decide whether to deduplicate (return the existing record) or create a second
  entry. The Frontend agent handles whichever response the server sends; no
  special UI is needed beyond the normal add-question flow. If the server
  deduplicates, the pending row resolves to the existing row (no new row
  appears). If the server allows duplicates, the second row is added normally.
  This decision is the Architect's; the UI is agnostic.

### E4. Spread value of exactly 0%

- "0%" is a valid spread (both platforms have the same price). It renders in
  the `spread-neutral` treatment as "0.0%". It is not treated as null.

### E5. Slow network / spread fetch timeout

- If the spread data fetch (either on page load or on a poll interval)
  times out after 15 seconds, the list rows remain in the loading/skeleton
  state and a non-blocking banner appears at the top of the list area:
  "Spread data is taking longer than usual. Retrying…"
  This is a `role="status"` (polite) banner, not a `role="alert"`.
  The system retries automatically; no user action is required.
- If three consecutive fetches fail, the banner upgrades to:
  "We're having trouble fetching spread data. Check your connection."
  This remains `role="status"` (polite) — it is not a critical error.

### E6. Cron has not run yet (user added a question moments ago)

- Immediately after adding a question, spread data may be null because the
  cron has not run since the question was added. The row shows "—" in the
  null-spread treatment with timestamp "just now" (reflecting when the question
  was added, not when the spread was fetched).
- This is indistinguishable from the "only 1 platform matched" null state
  visually. The aria-label differentiates: "Spread not yet available — first
  fetch pending".
- After the next cron run, the value populates normally.

### E7. RTL locale

- All layout uses CSS logical properties. The platform chips strip flows in
  the inline direction and wraps naturally.
- The spread value always renders adjacent to the timestamp; their relative
  order (spread left of timestamp, or spread above timestamp) is determined
  by available space, not hard-coded directionality.
- The key-error banner icon is positioned with logical properties so it
  appears on the correct leading edge in RTL.

### E8. Dark mode

- The `spread-alert` treatment (green family) must achieve sufficient contrast
  against both light and dark backgrounds. The Frontend agent must verify both
  modes meet WCAG AA (4.5:1 for text).
- The key-error banner `banner-error` treatment must be distinguishable in
  dark mode — not relying on a light-red tint that becomes invisible on a dark
  background.
- Skeleton shimmer animation must have a visible contrast differential in dark
  mode (not just a grey-on-grey shimmer).

### E9. Session expires while on the dashboard

- If the session expires during a dashboard visit, the next data fetch returns
  401. The page shows a full-page banner (not inline):
  "Your session has expired. Sign in again to continue your session."
  with a "Sign in" button → navigates to `/signin`.
- No spread data is shown after session expiry. The watched-questions list is
  preserved in the UI until the user navigates away (the list is client-cached
  from the last successful load).

### E10. Platform deeplink is unavailable (platform returns no URL)

- If a platform matched the question but did not return a market URL (e.g.
  the API response was partial), the chip renders as a no-match chip (greyed,
  no link) for that platform, even though a match was found.
- This edge case is indicated in the chip's `aria-label`:
  "Matched on {Platform} — link unavailable"
- The spread calculation is still valid even if the URL is missing.

### E11. All 4 platforms matched but spread is null

- This can occur if two platforms have identical prices (0% spread) and the
  other two have no price. In this case spread is 0%, not null.
- True null spread means fewer than 2 platforms returned a valid price. The
  UI represents this as "—" with the null-spread aria-label.

### E12. `cooldown_ends_at` timestamp in the past (quota-exhausted state)

- If the server sends a `cooldown_ends_at` that is in the past (indicating
  the cooldown has elapsed but the key status has not been updated yet), the
  banner body falls back to the "no cooldown timestamp" copy:
  "Your Anakin key has hit its quota — refreshes paused. Top up your Anakin
  account at anakin.company/wire to resume."
  The Frontend agent should check: if `cooldown_ends_at < now()`, treat it
  as absent.

---

## 9. Settings Page Placeholder

The key-error banners reference `/settings/key` as the destination for
resolving key errors. The Settings page is out of scope for this spec. It
presents the same key-input form as `/onboarding/key` (see
auth-and-onboarding.md §3C) but is non-blocking (the user can navigate away
without saving). The full Settings spec is a separate design document to be
written in a future sprint.

---

*Spec authored for sprint 1 / story-dashboard-design. Questions or amendments go to the designer before the Frontend agent picks up the dashboard implementation task.*
