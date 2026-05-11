# Auth-flow security review

**Reviewer:** zeus:security
**Sprint:** 2
**Scope:** Magic-link auth flow shipped in story-magic-link-auth.
**Verdict:** **Pass — Phase 1 close unblocked.** 4 follow-ups (1 medium, 3 low/info) tracked.

## Summary
The auth surface is sound. NextAuth v5 generates tokens via a 256-bit CSPRNG, stores them as keyed SHA-256 hashes, deletes them atomically on first use, and issues HttpOnly / Secure / SameSite=Lax session cookies. CSRF is validated on every mutating POST in production. The `redirect` callback in `auth.ts:80-84` confines `callbackUrl` to same-origin paths. The `/api/me` endpoint self-defends with a session+expiry check; no parameter pivots to other users. No finding is exploitable against demo data today.

## Detailed findings

### 1. Token entropy — Pass
`@auth/core/lib/utils/web.js:84-89` uses `crypto.getRandomValues(new Uint8Array(32))` → 256 bits of CSPRNG entropy per token. Tokens are stored as `SHA-256(token + APP_SECRET)` (see `send-token.js:63`), so brute-forcing the DB without the application secret is infeasible.

### 2. Token replay — Pass
`@auth/drizzle-adapter/lib/sqlite.js:175-182` issues a single `DELETE ... WHERE identifier = ? AND token = ? RETURNING`. SQLite serialises writes; on Postgres, `DELETE ... RETURNING` is atomic within the Drizzle-managed transaction. No read-before-delete race.

### 3. Token timing on DB lookup — Accepted
`useVerificationToken` uses an indexed B-tree lookup (not constant-time). The plaintext token is never written to the DB (a keyed hash is), so timing attacks would need DB-read access already. Sub-microsecond timing delta vs network jitter. **Info-level, no action — revisit at Phase 3 if a network-adjacent adversary enters the threat model.**

### 4. Cookie flags — Pass
`auth.ts:64-75` sets `httpOnly: true`, `sameSite: "lax"`, `secure: process.env.NODE_ENV === "production"`, `maxAge: 30 days`. In production the cookie name is `__Secure-next-auth.session-token` (gated by the `__Secure-` prefix rule).

### 5. Open-redirect on post-login — Pass
`auth.ts:80-84`'s `redirect` callback rejects external hosts: returns `baseUrl` when `url` neither starts with `baseUrl` nor `/`. Email template embeds only the server-constructed magic-link URL — user-controlled `callbackUrl` is filtered before email send.

### 6. CSRF on the sign-in form — Pass (with one low-severity scoping note)
Double-submit cookie pattern via `validateCSRF` in `@auth/core/lib/index.js:50-65`. `SignInForm.tsx:70-72` fetches the token from `/api/auth/csrf` and submits it with every POST. **Low-severity scoping concern:** `auth.ts:78` spreads `{ skipCSRFCheck }` when `NODE_ENV === "test"`. Production never sets `NODE_ENV=test`, so this is correctly scoped, but a preview/staging environment accidentally configured with `NODE_ENV=test` would silently disable CSRF. See follow-up F2.

### 7. Rate limiting on magic-link request — Medium gap
No server-side rate-limit on `POST /api/auth/signin/email`. The 60s cooldown on `/check-email`'s resend button (`ResendButton.tsx:5`) is client-only and is bypassed by direct HTTP. Resend's free tier caps at 100 emails/day — an attacker can exhaust this in seconds, locking out legitimate users. Not exploitable in the private single-user demo, but a real gap before any public URL sharing. See follow-up F1.

### 8. Email content / link verification — Pass
`auth.ts:32-51`'s `sendVerificationRequest` builds the body around a single server-constructed URL. The subject is the static string "Sign in to ArbWatch". `identifier` and `callbackUrl` are not reflected in the visible email body. The recipient is the email being authenticated; cannot be redirected.

### 9. Session fixation — Pass
`@auth/core/lib/actions/callback/handle-login.js:61-87`: any pre-auth session cookie is deleted before a fresh `generateSessionToken()` (UUID v4, 122 bits) creates the new session row.

### 10. `/api/me` exposure — Pass
`app/api/me/route.ts:11-48` performs a JOIN against `sessions` with `gt(sessions.expires, now)` then returns `{ id, email, anakin_key_status }`. No raw ciphertext, no route/query/body parameter accepted; cannot pivot to another user.

### 11. Middleware coverage — Low gap
`middleware.ts:33-35` matcher covers `/`, `/signin`, `/dashboard`, `/onboarding/:path*`, `/settings/:path*`. **`/api/me` is missing.** The route self-defends with a 401, so this is a defense-in-depth gap, not an auth bypass. One-line fix. See follow-up F3.

## Tracked follow-ups

| # | Severity | Description | Recommended phase |
|---|---|---|---|
| F1 | MEDIUM | Add server-side rate limit on `POST /api/auth/signin/email` (e.g. 3 req / 10 min per email+IP) before any public URL is shared | Phase 2 sprint 1 (hardening) |
| F2 | LOW | Replace the `NODE_ENV === "test"` guard around `skipCSRFCheck` with an explicit `SKIP_CSRF_CHECK=true` env var that is never set in staging | Phase 1 sprint 3 hardening or pre-staging |
| F3 | LOW | Add `/api/me` to the matcher in `middleware.ts` so unauthenticated browser navigations redirect to `/signin` instead of returning raw JSON | Phase 1 sprint 3 hardening (one-line fix) |
| F4 | INFO | Token-lookup timing on `useVerificationToken` is O(log n); accept under Phase 1 threat model; revisit if multi-user threats include a DB-adjacent timing adversary | Phase 3 |

## Cross-references
- ADR-0001 §Sessions — 30-day max-age, token TTL
- `auth.ts:13-14` — `SESSION_MAX_AGE`, `TOKEN_MAX_AGE`
- `auth.ts:64-75` — cookie flags
- `auth.ts:78` — test-mode CSRF bypass (F2)
- `auth.ts:80-84` — open-redirect guard
- `middleware.ts:33-35` — matcher (F3)
- `app/api/me/route.ts:11-48` — session-gated identity endpoint
- `app/signin/SignInForm.tsx:70-72` — CSRF fetch
- `@auth/drizzle-adapter/lib/sqlite.js:175-182` — atomic token consumption
- `@auth/core/lib/utils/web.js:84-89` — CSPRNG
- `@auth/core/lib/actions/signin/send-token.js:43,63` — token gen + keyed hash
- `@auth/core/lib/actions/callback/handle-login.js:61-87` — session fixation defense
