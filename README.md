# ArbWatch — Cross-platform prediction-market arbitrage scanner

ArbWatch surfaces arbitrage spreads across Kalshi, Manifold, Polymarket, and Robinhood Prediction Markets. Bring your own Anakin Wire API key; the app matches questions across platforms and sends email alerts when cross-platform spreads exceed 3%.

**Status:** Phase 1 (MVP) — in development. See [PROJECT.md](PROJECT.md) for the phased roadmap and success criteria.

## Quickstart

Prerequisites:
- Node 20 (see [nodejs.org](https://nodejs.org) for install)
- npm (bundled with Node)

```bash
git clone https://github.com/arun-singh/predmkt-arb
cd predmkt-arb
./preview.sh
```

Open `http://localhost:3000`.

You can sign in using the seeded fixture user (email: `fixture@arbwatch.test`). `WIRE_MODE=fixtures` is the default, so no live Anakin credentials are required for local development — the app serves synthetic market data from JSON fixtures.

The `preview.sh` script:
- Generates `.env` from `.env.example` with safe local defaults if `.env` is missing
- Installs npm dependencies if `node_modules` is absent
- Runs database migrations
- Seeds the database with test data
- Starts the Next.js dev server and prints `http://localhost:3000` when ready

The entire process takes under 60 seconds on a clean checkout.

## Environment variables

Every variable in [`.env.example`](.env.example):

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | SQLite file path for dev (e.g., `file:./local.db`). In production, a Neon Postgres URL. |
| `APP_ENCRYPTION_KEY` | Yes | 32 random bytes in base64. Used to encrypt user Anakin API keys at rest. `preview.sh` sets a deterministic placeholder for local dev. |
| `AUTH_SECRET` | Yes | Secret for signing session tokens. `preview.sh` sets a dev-only value. In production, use `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Yes | Deployed app URL (used by NextAuth for callback redirects). Defaults to `http://localhost:3000` in development. |
| `WIRE_MODE` | Yes | `fixtures` (default, local dev) or `live` (production, calls real Anakin Wire endpoints). |
| `RESEND_API_KEY` | No | Email API key (Resend). Only required when `WIRE_MODE=live` and magic-link emails are sent. |
| `EMAIL_FROM` | No | Sender email address for transactional email. Only required when `WIRE_MODE=live`. |
| `CRON_SECRET` | No | Random string to authenticate the `/api/cron/*` routes in production. Not needed locally. |

In local dev, `preview.sh` auto-generates `.env` with safe defaults. You don't need to fill anything in manually to get the app running.

## Run tests

```bash
npm run test:unit     # Unit tests (Vitest)
npm run test:e2e      # End-to-end tests (Playwright)
npm test              # Run both test:unit and test:e2e in sequence
```

- `test:unit` covers library logic and utility functions.
- `test:e2e` covers user flows (auth, dashboard interactions) against a live dev server.
- Watch mode (dev only): `npm run test:unit:watch`.

## Project layout

```
app/                     # Next.js App Router (pages, API routes, layouts)
db/                      # Drizzle ORM schema + migration scripts
scripts/                 # Build and seed scripts (e.g., seed.ts, record-wire-fixture.ts)
tests/                   # Unit tests (Vitest) and E2E tests (Playwright)
docs/architecture/       # Technical decision records (ADRs)
docs/design/             # UX and product design specs
SPRINTS/                 # Sprint planning, reviews, and retrospectives
.sdlc/                   # Orchestrator config (not user-facing)
```

## Where to look next

- [PROJECT.md](PROJECT.md) — product vision, phases, and success criteria.
- [BACKLOG.yaml](BACKLOG.yaml) — open stories and epics.
- [docs/architecture/0001-stack.md](docs/architecture/0001-stack.md) — stack selection, free-tier budget, and locked-in decisions.
- [docs/architecture/0002-wire-integration.md](docs/architecture/0002-wire-integration.md) — Anakin Wire credential scoping, error handling, and fixture mode.
- [docs/design/auth-and-onboarding.md](docs/design/auth-and-onboarding.md) — auth flow, email copy, and error taxonomy.
- [SPRINTS/002/plan.md](SPRINTS/002/plan.md) — current sprint stories and goals.

## Disclaimers

Arbitrage ≠ profit. Slippage, exchange fees, and settlement risk may consume or exceed any spread. This app shows data only; it makes no investment recommendations.
