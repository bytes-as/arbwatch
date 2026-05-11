# Credential-storage security review

**Reviewer:** zeus:security
**Sprint:** 2
**Scope:** BYO-Anakin-key storage path shipped in story-anakin-key-storage.
**Verdict:** **Pass — Phase 1 close unblocked.** 6 follow-ups (3 medium, 3 low) tracked.

## Summary
Encryption scheme (AES-256-GCM, random 12-byte nonce per write, AAD = `user.id`, 32-byte key from `APP_ENCRYPTION_KEY`) is correctly implemented. Auth gating is session-derived only — no IDOR path. Plaintext lifetime is bounded to the Wire call frame. DB CHECK constraint enforces the four-value status enum at the SQL level. Three medium-severity follow-ups (key rotation, KMS migration, all-zero-key guard) must be resolved before paid users in Phase 3.

## Detailed findings

### 1. Encryption-at-rest — Pass
`db/encryption.ts` uses `gcm()` from `@noble/ciphers/aes.js`. 32-byte key enforced via runtime length check (lines 7-16). Fresh 12-byte nonce per encrypt via `randomBytes(NONCE_LENGTH)` (line 25) — no reuse possible. AAD = `user.id` on both encrypt (`route.ts:105`) and decrypt (`lib/wire/decrypt.ts:89`). On-disk layout `nonce(12) || ciphertext || tag(16)` matches ADR-0001.

### 2. KMS / env-secret threat model — Two medium gaps
Key is in `process.env.APP_ENCRYPTION_KEY` (Vercel project env in prod; `.env` locally). Acceptable for Phase 1 single-user demo.
- **Rotation gap (medium, F1):** rotating `APP_ENCRYPTION_KEY` invalidates every stored ciphertext (next decrypt fails with GCM-auth error → status flips to `key-invalid`). Need dual-key decrypt + re-encrypt-on-read before paid users.
- **Blast radius (medium, F2):** anyone with DB + env access can decrypt every user's Anakin key. Move to KMS hop (Vercel KMS / AWS KMS) before Phase 3.

### 3. AAD cross-user defense — Pass
GCM tag check fails when AAD mismatches. Test `tests/key/isolation.test.ts:315-358` directly exercises this with `decryptAESGCM` + wrong AAD and asserts `.rejects.toThrow()`. Production paths confirmed to use `aad = user.id` consistently.

### 4. Log redaction — Low gap
**F3:** ADR-0002 describes a Pino redact path (`["headers.authorization", "*.apiKey", "*.api_key", "*.anakin_key"]`) but Pino is not in `package.json`; no structured logger exists today. In practice no `console.log` of plaintext exists; the Suite-4 no-log tests in `encryption.test.ts:479-527` pass. Implement the redact path *before* a structured logger is introduced (otherwise a future addition will trivially regress no-log assertions).

### 5. Exposure surface in error paths — Pass
All error paths through `decrypt` / `decryptAESGCM` throw generic `Error`s with no sensitive data:
- `db/encryption.ts:12-14, 37` — config / length errors, no plaintext
- `lib/wire/decrypt.ts:40-42` — key-length error, no plaintext
- `WireError` (`errors.ts:19`) — message = error-class tag only (`key-missing` | `key-invalid` | `quota-exhausted`)
- `app/api/me/anakin-key/probe/route.ts:68-93` — caught `WireError` serialised as `{ error, errorTag, code }` (all = class tag); non-WireError re-thrown to Next.js generic 500.

### 6. IDOR on key endpoints — Pass
All three handlers in `app/api/me/anakin-key/route.ts` call `resolveSession(request)` first (lines 56, 85, 123). User ID is derived from the HTTP-only session cookie only — `request.nextUrl.searchParams.get('user_id')` is never read; request body's `user_id` is never read. Probe route (`probe/route.ts:53,67`) same pattern. Test `tests/key/isolation.test.ts:244-283` confirms.

### 7. Plaintext lifetime in memory — Pass
`lib/wire/client.ts:wireRequest` (lines 42-99): `plaintext` is a `const` in the function scope. Used to build `authHeader` line 51, passed to `fetch` line 68 (live mode) or `recordWireCall` line 55 (test-only fixture path, gated on `wireMode === "fixtures"` + `NODE_ENV === "test"`). Closure `doFetch` captures `authHeader` for retry but is GC-eligible once `wireRequest` returns. `_clientCache` (line 22) typed for `{ cipherDigest }` only — no plaintext retention.

### 8. Probe-based status progression — Low gap
**F4:** `POST /api/me/anakin-key` (`route.ts:100-115`) intentionally does NOT update `anakin_key_status` to `ok` — the comment is explicit that status transitions to `ok` only via a Wire probe. The probe endpoint (`/api/me/anakin-key/probe`) exists but is not called inline from the POST handler. Today this means `anakin_key_status` stays `key-missing` after paste; the dashboard banner persists until a cron tick (which isn't built yet — Sprint 3). UX gap, not security. Sprint 3 will wire the inline probe call on key-paste. Also note: `encryption.test.ts` Suite 1 line 254 asserts `status === "ok"` after POST, which would contradict the implementation — reconcile in Sprint 3 (**F5**).

### 9. Replay of the encrypt-on-paste flow — Documented, not flagged
Replaying a captured POST overwrites the user's ciphertext with the replayed plaintext. Attacker needs a valid session cookie + the plaintext key — the actual secret. No amplification. Inherent to "paste and save" semantics.

### 10. Drizzle CHECK constraint integrity — Pass
`drizzle/0000_even_mysterio.sql:29` and `drizzle/0001_lumpy_war_machine.sql:21` both declare the CHECK constraint on `anakin_key_status` enforcing the four values. SQL-level rejection on direct write. Drizzle schema (`db/schema.ts:26-29`) provides defense-in-depth at the TS layer. Test `encryption.test.ts` Suite 3 (lines 372-457) covers direct-write rejection.

### 11. Encryption-key entropy — Medium gap
**F6:** `.env.example:15` and `preview.sh:16` both seed `APP_ENCRYPTION_KEY=AAAAAA...AAA=` (32 zero-bytes). Correctly labeled as a dev-only placeholder. **There is no runtime check that this all-zero value isn't accidentally set in production.** Add a startup guard in `db/encryption.ts:getKey()`: if `NODE_ENV === "production"` AND decoded key bytes are all zero (or below an entropy threshold), throw at server start. Must land before the first non-demo production deployment.

## Tracked follow-ups

| # | Severity | Description | Recommended phase |
|---|---|---|---|
| F1 | MEDIUM | Implement APP_ENCRYPTION_KEY rotation via dual-key decrypt + re-encrypt-on-read | Phase 3 (before Stripe billing) |
| F2 | MEDIUM | Move encryption key to a KMS hop (Vercel KMS / AWS KMS) so DB access alone is insufficient | Phase 3 |
| F3 | LOW | Add the Pino logger with the ADR-0002 redact path before any structured logging is introduced | Phase 2 (or whenever structured logging is first added) |
| F4 | LOW (UX) | Wire the inline Wire probe call on key-paste so `anakin_key_status` transitions to `ok` immediately on a valid key | Sprint 3 |
| F5 | LOW (test) | Reconcile `encryption.test.ts` Suite-1 line 254's `status === "ok"` assertion with the actual probe-deferred behavior | Sprint 3 |
| F6 | MEDIUM | Add fail-fast guard in `getKey()` for all-zero / low-entropy `APP_ENCRYPTION_KEY` in production | Before first non-demo production deployment |

## Cross-references
- ADR-0001 §"Encryption" — algorithm choice, env-var convention
- ADR-0002 §"Per-call credential injection" — AAD scheme, lifecycle
- ADR-0002 §"Error taxonomy" — the four status enum values
- `db/encryption.ts:1-44` — AES-256-GCM helper
- `db/schema.ts:26-29` — TS enum
- `drizzle/0000_even_mysterio.sql:29` — SQL CHECK constraint
- `drizzle/0001_lumpy_war_machine.sql:21` — named CHECK constraint
- `app/api/me/anakin-key/route.ts:56,85,123` — session-gated handlers
- `app/api/me/anakin-key/route.ts:100-115` — probe-deferred status
- `app/api/me/anakin-key/probe/route.ts` — probe endpoint (not yet wired inline on paste; F4)
- `lib/wire/client.ts:42-99` — plaintext-bounded `wireRequest`
- `lib/wire/decrypt.ts:40-95` — per-call decrypt
- `tests/key/isolation.test.ts:244-283` — IDOR test
- `tests/key/isolation.test.ts:315-358` — AAD cross-user test
- `tests/key/encryption.test.ts:479-527` — no-log assertion
- `.env.example:15`, `preview.sh:16` — placeholder key (F6)
