# Auth + Key Onboarding UX Spec

**Feature slug:** auth-and-onboarding  
**Phase:** phase-1-mvp  
**Story:** story-onboarding-design  
**Status:** draft — sprint 1

---

## 1. User Intent

The user wants to start tracking cross-platform prediction-market spreads; to do that they must create an account with their email address and connect their Anakin API key.

---

## 2. Flow

### 2A. Happy-path: New user

```
1.  User visits the app root (/).
2.  App detects no session → redirects to /signin.
3.  User sees the Sign-In page.
4.  User types their email address and clicks "Send magic link".
5.  Button enters loading state (spinner, minimum 200 ms).
6.  Server enqueues the magic-link email; page navigates to /check-email
    and passes the obfuscated address as a display hint.
7.  User opens their email client and clicks the magic link.
8.  Magic link opens /auth/verify?token=<TOKEN> in whatever browser the
    link is clicked in (need not be the browser where the request was made —
    see edge case E5).
9.  Server validates token: single-use, within TTL, unrevoked.
10. Server creates/retrieves user record, issues a session cookie
    (HttpOnly, Secure, SameSite=Lax, max-age = 30 days), marks token used.
11. Server checks whether the user has an Anakin key on file.
    - No key → redirect to /onboarding/key.
    - Key present → redirect to /dashboard.
12. /onboarding/key: user reads help text, pastes their Anakin API key, clicks
    "Save key".
13. Client runs format validation (see §4 Onboarding — Key Input states).
    - Invalid format → inline error, no server call.
14. Server receives key, runs a lightweight probe Wire call.
    - Probe succeeds → key stored encrypted at rest → redirect to /dashboard
      with welcome toast.
    - Probe fails with key-invalid → inline error, field remains editable.
    - Probe fails with quota-exhausted → inline error, field remains editable.
15. /dashboard (empty state): user sees the empty watched-questions list and
    the "Add your first question" prompt.
```

### 2B. Returning authenticated user revisits /signin

```
1.  User is already signed in (valid session cookie).
2.  User navigates to /signin.
3.  App detects active session → immediate client-side redirect to /dashboard.
    No sign-in UI is rendered; the redirect happens before paint.
```

### 2C. Returning authenticated user revisits /onboarding/key (key already on file)

```
1.  User is signed in and has a key stored.
2.  User navigates to /onboarding/key.
3.  App detects key present → immediate redirect to /dashboard.
    (The key-rotation UI lives in /settings, not in onboarding.)
```

### 2D. Expired magic-link token

```
1.  Steps 1–7 of happy path.
2.  User clicks the magic link after the token TTL has expired.
3.  /auth/verify detects expired token.
4.  Server redirects to /signin?error=expired.
5.  Sign-In page renders with an error banner above the form
    (see §4 Sign-In states — "expired" error).
6.  User can request a new magic link without clearing the email field
    (pre-populate from localStorage or session-storage if available).
```

### 2E. Already-used (replayed) magic-link token

```
1.  User clicks a magic link they have already used.
2.  /auth/verify detects token is marked used.
3.  Server checks whether the user is already authenticated in this browser.
    a.  If already authenticated → redirect to /dashboard.
    b.  If not authenticated → redirect to /signin?error=used.
4.  Sign-In page renders with an error banner (see §4 — "used" error).
5.  User can request a new magic link.
```

### 2F. Invalid / wrong Anakin key (server-side probe fails)

```
1.  Steps 1–12 of happy path.
2.  User pastes a key that passes format validation but is rejected by Wire
    (error code key-invalid per ADR-0002).
3.  Submit button completes loading state (minimum 200 ms).
4.  Inline error appears below the key field (see §4 Onboarding — "key-invalid").
5.  Field remains editable; user corrects and resubmits.
```

### 2G. Quota-exhausted key discovered during onboarding probe

```
1.  Steps 1–12 of happy path.
2.  Probe returns quota-exhausted (ADR-0002).
3.  Inline error appears (see §4 Onboarding — "quota-exhausted").
4.  User is told to top up their Anakin account; field editable for a fresh key.
```

### 2H. Quota-exhausted key discovered later (dashboard key-error banner)

```
1.  User is on /dashboard.
2.  Spread-refresh cron fails for this user with quota-exhausted.
3.  Dashboard renders a persistent key-error banner at the top of the page.
4.  Banner has a "Update key" link → opens /settings/key (same form as
    onboarding, but without forced blocking; user can dismiss the banner
    and browse stale data with a staleness label).
5.  User pastes a fresh key on /settings/key, saves, banner clears on
    next successful cron run (or optimistically on successful probe save).
```

---

## 3. Layout

### 3A. Sign-In Page (/signin)

```
┌─────────────────────────────────────────────────────┐
│  [App logo / wordmark]                              │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  CARD                                         │  │
│  │                                               │  │
│  │  [Error banner — conditionally rendered]      │  │
│  │                                               │  │
│  │  h1: "Sign in to ArbWatch"                    │  │
│  │  p:  "Enter your email and we'll send you a   │  │
│  │       one-time sign-in link. No password."    │  │
│  │                                               │  │
│  │  label: "Email address"                       │  │
│  │  [input type=email  id=email                  │  │
│  │   placeholder="you@example.com"               │  │
│  │   autocomplete="email"                        │  │
│  │   autofocus]                                  │  │
│  │                                               │  │
│  │  [button: "Send magic link"  type=submit]     │  │
│  │                                               │  │
│  │  p (small): "We'll only use your email to     │  │
│  │  send sign-in links and spread alerts."       │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

Component hierarchy:

- `<main>` (landmark, `aria-label="Sign in"`)
  - Logo/wordmark (decorative `<img>` with `alt=""` or SVG with `aria-hidden`)
  - `<section>` card
    - Error banner `<div role="alert">` — visible only when `?error=` param present
    - `<h1>` heading
    - Subheading `<p>`
    - `<form>` `action="/auth/request"` `method="POST"`
      - `<label for="email">` + `<input id="email">`
      - `<button type="submit">`
    - Privacy note `<p>`

---

### 3B. Check-Email Page (/check-email)

```
┌─────────────────────────────────────────────────────┐
│  [App logo / wordmark]                              │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  CARD                                         │  │
│  │                                               │  │
│  │  [Envelope illustration — decorative]         │  │
│  │                                               │  │
│  │  h1: "Check your inbox"                       │  │
│  │                                               │  │
│  │  p: "We sent a sign-in link to               │  │
│  │      [obfuscated-email]. Click the link       │  │
│  │      in that email to continue."             │  │
│  │                                               │  │
│  │  p (small): "Link expires in 15 minutes.      │  │
│  │  Didn't get it?"                              │  │
│  │  [button/link: "Resend"]                      │  │
│  │                                               │  │
│  │  [button/link: "Use a different email"]       │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

Component hierarchy:

- `<main>` (`aria-label="Email sent confirmation"`)
  - Logo
  - `<section>` card
    - Illustration (`<img alt="">` or inline SVG `aria-hidden="true"`)
    - `<h1>`
    - Confirmation paragraph with obfuscated email in `<strong>`
    - Expiry note + Resend `<button type="button">`
    - "Use a different email" `<a href="/signin">` or `<button>`

Note: The TTL shown in copy ("15 minutes") is a placeholder. The Frontend agent must pull the value from the token-TTL constant set by the Architect in ADR-0001. If the Architect has not yet published that constant, use 15 minutes and leave a `<!-- TODO: sync with ADR-0001 TTL -->` comment.

---

### 3C. Onboarding: Paste Anakin Key (/onboarding/key)

```
┌─────────────────────────────────────────────────────┐
│  [App logo / wordmark]                              │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  CARD                                         │  │
│  │                                               │  │
│  │  h1: "Connect your Anakin API key"            │  │
│  │                                               │  │
│  │  p: "ArbWatch uses your Anakin Wire key to    │  │
│  │  fetch live market data across Kalshi,        │  │
│  │  Manifold, Polymarket, and Robinhood. You are │  │
│  │  charged directly on your Anakin account —    │  │
│  │  we never pay for your Wire credits."         │  │
│  │                                               │  │
│  │  p (help link):                               │  │
│  │  "Don't have a key? Get one at                │  │
│  │   [anakin.company/wire ↗]"                   │  │
│  │                                               │  │
│  │  label: "Anakin API key"                      │  │
│  │  [input type=password  id=anakin-key          │  │
│  │   autocomplete="off"                          │  │
│  │   spellcheck="false"                          │  │
│  │   placeholder="Paste your key here"           │  │
│  │   autofocus]                                  │  │
│  │  [toggle: show/hide key — button]             │  │
│  │                                               │  │
│  │  [inline error — conditionally rendered]      │  │
│  │                                               │  │
│  │  p (security note, small):                    │  │
│  │  "Your key is encrypted before it is stored   │  │
│  │  and is only used to make Wire calls on your  │  │
│  │  behalf. It is never logged or shared."       │  │
│  │                                               │  │
│  │  [button: "Save key"  type=submit]            │  │
│  │                                               │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

Component hierarchy:

- `<main>` (`aria-label="API key setup"`)
  - Logo
  - `<section>` card
    - `<h1>`
    - Description paragraph
    - Help link paragraph: `<a href="https://anakin.company/wire" target="_blank" rel="noopener noreferrer">`
    - `<form>` `action="/api/key"` `method="POST"`
      - `<label for="anakin-key">` + password `<input id="anakin-key">`
      - Show/hide toggle `<button type="button" aria-label="Show key" aria-pressed="false">`
      - Inline error `<p role="alert" id="key-error">` (conditionally rendered; `<input>` references it via `aria-describedby="key-error"`)
      - Security note `<p>`
      - `<button type="submit">`

---

### 3D. /auth/verify (Token Validation — no visible UI except redirect)

This route is a server-side endpoint. The user never sees a page here under normal conditions. On error it redirects to /signin with a query-string error code. There is no layout to specify.

---

## 4. States

### 4A. Sign-In Page — Input and Button States

| State | Email input | Submit button | Notes |
|---|---|---|---|
| Idle/empty | Focused (autofocus), no value | Enabled, full opacity | Autofocus on mount |
| Typing | Active, no validation | Enabled | No inline validation while typing |
| Invalid email format (on blur) | Red border, `aria-invalid="true"`, error message below | Enabled | Error: "Enter a valid email address." |
| Submitting | Disabled, grayed | Loading: spinner replaces label text, disabled, `aria-label="Sending…"` | Spinner shown minimum 200 ms |
| Success | — | — | Page navigates to /check-email |
| Error — expired token (`?error=expired`) | Pre-populated from storage if available, enabled | Enabled | Error banner above form |
| Error — used token (`?error=used`) | Pre-populated from storage if available, enabled | Enabled | Error banner above form |
| Error — server failure | Enabled | Re-enabled after failure | Toast or banner: "Something went wrong. Try again." |

### 4B. Check-Email Page — Resend Button States

| State | Resend button |
|---|---|
| Idle | Enabled, label: "Resend" |
| Clicked (cooldown 60 s) | Disabled, label: "Resend (59s)" counting down, `aria-label="Resend disabled, wait 59 seconds"` |
| Cooldown expired | Re-enabled, label: "Resend" |
| Resend success | Brief inline message: "A new link is on its way." |
| Resend failure | Inline error: "Couldn't send. Try again." |

### 4C. Onboarding Key Input — States

| State | Key input | Show/Hide toggle | Submit button | Inline error |
|---|---|---|---|---|
| Idle | Focused (autofocus), empty, type=password | Label: "Show key", `aria-pressed="false"` | Enabled | Hidden |
| Typing | Active | Accessible | Enabled | Hidden |
| Format invalid (client, on blur or submit attempt) | Red border, `aria-invalid="true"` | Accessible | Re-enabled | Visible: see copy below |
| Submitting | Disabled | Disabled | Spinner, disabled, `aria-label="Saving key…"` | Hidden |
| Server error — key-invalid | Enabled, value retained, red border | Accessible | Re-enabled | Visible: see copy below |
| Server error — quota-exhausted | Enabled, value retained | Accessible | Re-enabled | Visible: see copy below |
| Server error — generic | Enabled | Accessible | Re-enabled | Visible: "Something went wrong. Try again." |
| Success | — | — | — | — (navigates away) |

---

## 5. Copy

### 5A. Sign-In Page

- **Page `<title>`:** "Sign in — ArbWatch"
- **`<h1>`:** "Sign in to ArbWatch"
- **Subheading `<p>`:** "Enter your email and we'll send you a one-time sign-in link. No password needed."
- **Email label:** "Email address"
- **Email placeholder:** "you@example.com"
- **Submit button (idle):** "Send magic link"
- **Submit button (loading):** *(spinner only; visually-hidden span: "Sending…")*
- **Privacy note:** "We'll only use your email to send sign-in links and spread alerts."

**Error banners (rendered in `<div role="alert">` at top of card):**

- `?error=expired` — "That sign-in link has expired. Enter your email below to get a new one."
- `?error=used` — "That sign-in link has already been used. Enter your email below to get a new one."
- `?error=server` — "Something went wrong on our end. Please try again."

**Inline email format error (below input):** "Enter a valid email address."

---

### 5B. Check-Email Page

- **Page `<title>`:** "Check your inbox — ArbWatch"
- **`<h1>`:** "Check your inbox"
- **Confirmation paragraph:** "We sent a sign-in link to **[email]**. Click the link in that email to continue."
- **Expiry note:** "The link expires in 15 minutes."
- **Resend note:** "Didn't get it?"
- **Resend button:** "Resend"
- **Resend counting-down label pattern:** "Resend (Xs)" where X counts down from 59 to 0
- **Resend success inline message:** "A new link is on its way."
- **Resend failure inline message:** "Couldn't send the email. Try again in a moment."
- **"Use a different email" link/button:** "Use a different email address"

**Email obfuscation rule:** Show first two characters, then `***`, then the `@domain`. Example: `ar***@example.com`. If the local part is one character, show that one character and `***`.

---

### 5C. Onboarding Key Page

- **Page `<title>`:** "Connect your Anakin key — ArbWatch"
- **`<h1>`:** "Connect your Anakin API key"
- **Description paragraph:**
  > "ArbWatch uses your Anakin Wire key to fetch live market data across Kalshi, Manifold, Polymarket, and Robinhood. Every Wire call is billed directly to your Anakin account — we never pay for your Wire credits."
- **Help link paragraph:**
  > "Don't have a key? Get one at [anakin.company/wire](https://anakin.company/wire)."
  - Link text: "anakin.company/wire"
  - `aria-label` on the `<a>`: "Get an Anakin Wire key (opens in new tab)"
- **Key input label:** "Anakin API key"
- **Key input placeholder:** "Paste your key here"
- **Show/hide toggle (hidden state):** "Show key"
- **Show/hide toggle (shown state):** "Hide key"
- **Submit button (idle):** "Save key"
- **Submit button (loading):** *(spinner; visually-hidden span: "Saving key…")*
- **Security note:**
  > "Your key is encrypted before it is stored and is only used to make Wire calls on your behalf. It is never logged or shared with third parties."

**Inline key errors (below input, in `<p role="alert">`):**

- Format invalid (client): "That doesn't look like a valid Anakin API key. Check for extra spaces or missing characters."
- `key-invalid` (server): "Anakin rejected this key. Double-check it in your Anakin dashboard and paste it again."
- `quota-exhausted` (server): "Your Anakin account has no remaining Wire quota. Top up your balance at [anakin.company/wire](https://anakin.company/wire), then paste your key again."
- Generic server error: "Something went wrong saving your key. Try again in a moment."

---

### 5D. Dashboard — Key-Error Banner (referenced from flow 2H)

*(Full dashboard layout is specified in docs/design/dashboard.md, but the banner copy is specified here because it originates from key-onboarding error states.)*

- **Banner heading:** "Wire calls paused"
- **`key-missing` body:** "No Anakin API key is on file. Add your key to resume spread tracking."
- **`key-invalid` body:** "Your Anakin API key is no longer valid. Update your key to resume spread tracking."
- **`quota-exhausted` body:** "Your Anakin account is out of Wire quota. Top up at [anakin.company/wire](https://anakin.company/wire) or paste a new key to resume spread tracking."
- **Banner CTA link:** "Update key" → `/settings/key`
- **Banner dismiss:** None. Banner is sticky until the underlying error resolves. (The user can still scroll past it to view stale spread data; a staleness label appears on each spread row.)

---

### 5E. Welcome Toast (after successful key save, on first redirect to /dashboard)

- **Toast text:** "You're all set. Start watching your first question below."
- Displayed for 5 seconds; auto-dismisses. `role="status"` (non-interrupting).

---

## 6. Keyboard and Accessibility

### 6A. Sign-In Page — Focus Order

1. Skip-to-main link (visually hidden until focused): "Skip to main content" → jumps to `<main>`
2. Logo (if a link to `/`, `aria-label="ArbWatch home"`)
3. Error banner (if present — focus is programmatically moved here on page load when `?error=` present, using `tabIndex="-1"` + `.focus()`)
4. Email input (`autofocus` on mount when no error param; otherwise focus moves to error banner first)
5. Submit button
6. "Use a different email" link (not present on sign-in page; present on check-email page)

**Keyboard interactions:**

| Element | Key | Behavior |
|---|---|---|
| Email input | `Enter` | Submits the form |
| Submit button | `Enter` / `Space` | Submits the form |
| Error banner link (if present) | `Enter` | Follows the link |

**ARIA notes:**

- `<form>` has `aria-label="Sign in with email"`
- Email input: `autocomplete="email"`, `type="email"`, `aria-required="true"`
- Submit button in loading state: `aria-disabled="true"` (not `disabled` so it remains focusable and reads "Sending…" to screen readers); visually disabled via CSS
- Inline email error: `<span id="email-error" role="alert">` referenced by `aria-describedby="email-error"` on the input; `aria-invalid="true"` on input when error is present

### 6B. Check-Email Page — Focus Order

1. Skip-to-main link
2. Logo
3. `<h1>` (focus moved here programmatically on page mount via `tabIndex="-1"`)
4. "Resend" button
5. "Use a different email address" link

**Keyboard interactions:**

| Element | Key | Behavior |
|---|---|---|
| Resend button | `Enter` / `Space` | Fires resend request; enters cooldown state |
| "Use a different email" | `Enter` | Navigates to /signin |

**ARIA notes:**

- Resend button in cooldown: `aria-disabled="true"`, `aria-label="Resend disabled, wait N seconds"` (updated each second via JS; only update `aria-label` every 5 seconds to avoid screen-reader verbosity)
- Resend success/error message: `<p role="status">` for success (polite), `<p role="alert">` for error (assertive)
- The obfuscated email in the confirmation paragraph is wrapped in `<strong>` and preceded by prose so screen readers read it naturally: "We sent a sign-in link to ar***@example.com"

### 6C. Onboarding Key Page — Focus Order

1. Skip-to-main link
2. Logo
3. `<h1>` (focus on mount via `tabIndex="-1"`)
4. Help link ("anakin.company/wire")
5. Key input (`autofocus` after `<h1>` focus settles — use a single rAF delay)
6. Show/hide toggle button
7. Security note (non-interactive; read by screen reader in document order)
8. Submit button

**Keyboard interactions:**

| Element | Key | Behavior |
|---|---|---|
| Key input | `Enter` | Submits the form |
| Show/hide toggle | `Enter` / `Space` | Toggles `type` between `password` and `text`; updates `aria-pressed` |
| Help link | `Enter` | Opens https://anakin.company/wire in new tab |
| Submit button | `Enter` / `Space` | Submits the form |

**ARIA notes:**

- Key input: `aria-label="Anakin API key"` (label element already provides this; `aria-label` not needed if `<label for>` is correct — use `<label>` as primary mechanism), `autocomplete="off"`, `spellcheck="false"`, `aria-required="true"`, `aria-describedby="key-security-note key-error"` (space-separated; `key-error` omitted from DOM when no error rather than hidden with CSS, so `aria-describedby` should be set dynamically or always include both IDs with the error element empty when no error)
- Show/hide toggle: `<button type="button" aria-pressed="false" aria-label="Show key">`. When toggled: `aria-pressed="true"`, `aria-label="Hide key"`.
- Inline key error: `<p id="key-error" role="alert">` — when no error, element exists in DOM but is empty (not `display:none`) so `aria-describedby` reference is stable
- Security note: `<p id="key-security-note">` — plain text, always present
- Submit button in loading state: `aria-disabled="true"`, visually-hidden text "Saving key…"
- The help link (`<a target="_blank">`) includes `(opens in new tab)` visually-hidden text appended inside the `<a>` — or use `aria-label` that includes the phrase

### 6D. Contrast and Visual Requirements

- All body text must meet WCAG AA contrast (4.5:1) against its background. Frontend agent chooses tokens; this spec does not prescribe colors but notes the requirement.
- Error states (red border, error text) must achieve at least 4.5:1 contrast for the error text. The red border alone must not be the sole error indicator — always pair with a text message.
- The show/hide toggle icon (if an icon is used) must have a visible text label or a tooltip/`aria-label` that is always present; the icon alone is not sufficient.
- Loading spinner must be accompanied by a visually-hidden text alternative.
- Focus ring must be clearly visible on all interactive elements; do not suppress `outline` without providing an equivalent focus indicator.

---

## 7. Edge Cases

### E1. Long email address

- The email input truncates visually at max-width but stores the full value. No max-length restriction is applied in the UI (server enforces reasonable limits).
- The obfuscated email on /check-email is truncated to a maximum of 40 visible characters before applying the obfuscation pattern, with a trailing ellipsis if truncated.

### E2. Very long or multi-line pasted Anakin key

- The key input is a single-line `<input>`. Pasting a multi-line string (e.g., accidentally including a newline) must strip leading and trailing whitespace (including `\n`) before format validation. Stripping is done client-side `onBlur` and `onSubmit`, not while the user is typing.
- The input `maxlength` attribute is set to 256 characters; anything longer is silently truncated on paste to that limit. A note is not shown unless the backend format regex would reject it.

### E3. Slow network / timed-out requests

- Magic-link request: if the server does not respond within 15 seconds, the submit button re-enables and a banner error appears: "The request timed out. Check your connection and try again."
- Key-save request: if the server does not respond within 15 seconds, same treatment with the message: "Saving timed out. Check your connection and try again."
- In both cases the spinner is shown for at least 200 ms even if the response is fast, to prevent UI flicker.

### E4. User clicks magic link in a different browser (cross-browser session)

- This is an explicitly supported flow. The token is validated server-side; no browser-fingerprint check is performed. The session cookie is set in the browser where the link is clicked.
- No special UI is needed. The flow proceeds as the happy path in that new browser.
- The browser where the original request was made is not notified (Phase 1 is single-user; no WebSocket presence channel).

### E5. User has no email client open / clicks the link after clearing browser history

- The verification endpoint (/auth/verify) is stateless from the browser's perspective; no browser state is required. The token in the URL is self-contained.
- The flow works normally; only the token TTL matters.

### E6. Repeated rapid form submissions (double-click or keyboard repeat)

- The submit button is disabled (`aria-disabled="true"`) immediately on first click during the loading state, preventing double submission.
- The server also enforces idempotency on the magic-link request endpoint (same email within a short window returns a 200 without sending a second email, or sends a new token that supersedes the previous one — exact behavior is the Architect's call per ADR-0001).

### E7. RTL locales

- All card layouts use CSS logical properties (`padding-inline`, `margin-block`, etc.) so they mirror correctly in RTL. The spec does not hardcode LTR-specific values.
- Inline error icons (if used) must be positioned using logical properties so they appear on the correct side in RTL.
- Phase 1 ships English only but the layout must not break if the browser language is set to an RTL locale.

### E8. Dark mode

- No design tokens are prescribed here. The Frontend agent must ensure:
  - Error banner background is distinguishable in both light and dark modes (not relying solely on a light-red tint).
  - Security note text remains readable (sufficient contrast) in dark mode.
  - The show/hide key toggle icon (if used) has appropriate contrast in both modes.

### E9. Signed-in user navigates directly to /onboarding/key but has no key yet

- User is signed in, has no key, and lands on /onboarding/key directly (e.g., from a bookmark).
- This is the normal onboarding flow. No redirect. Page renders normally.

### E10. Session expires while on /onboarding/key

- If the user's session cookie has expired (30-day max-age), the key-save request returns 401.
- The page shows a banner: "Your session has expired. Sign in again to continue." with a "Sign in" link to /signin.
- The pasted key value is cleared from the input field on session expiry for security.

### E11. JavaScript disabled

- The sign-in form `action="/auth/request" method="POST"` submits natively; the server redirects to /check-email. Core flow works.
- Client-side email format validation is bypassed; server validates and returns an error page with a back link.
- The show/hide key toggle requires JavaScript and is simply absent without JS; the key field defaults to `type="password"`.
- The resend cooldown counter requires JavaScript; without it, the Resend button is always enabled (the server enforces rate-limiting).

---

## 8. Route Summary

| Route | Auth required | Key required | Notes |
|---|---|---|---|
| `/signin` | No (redirect to /dashboard if authed) | — | Entry point |
| `/check-email` | No | — | Intermediate state; no direct navigation guard |
| `/auth/verify` | No | — | Server endpoint; redirects only |
| `/onboarding/key` | Yes (redirect to /signin if not authed) | No (redirect to /dashboard if key present) | Forced first-login gate |
| `/dashboard` | Yes (redirect to /signin if not authed) | No (renders key-error banner if key missing/invalid) | Post-onboarding home |
| `/settings/key` | Yes | No | Key rotation; out of scope for this spec but referenced |

---

*Spec authored for sprint 1 / story-onboarding-design. Questions or amendments go to the designer before the Frontend agent picks up task-auth-frontend and task-key-frontend.*
