#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Generate .env from .env.example if .env is missing
# ---------------------------------------------------------------------------

if [ ! -f .env ]; then
  echo "preview.sh: .env not found — generating from .env.example with local defaults"
  cp .env.example .env
  sed -i.bak 's|^DATABASE_URL=.*|DATABASE_URL=file:./local.db|' .env
  sed -i.bak 's|^WIRE_MODE=.*|WIRE_MODE=fixtures|' .env
  sed -i.bak 's|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=|' .env
  sed -i.bak 's|^AUTH_SECRET=.*|AUTH_SECRET=local-dev-secret-not-for-production|' .env
  rm -f .env.bak
fi

# Source .env to make vars available to child processes.
# Only export vars that are NOT already set in the environment so that
# callers (e.g. the Playwright test harness) can override DATABASE_URL etc.
while IFS='=' read -r key value || [ -n "$key" ]; do
  # Skip blank lines and comments
  [[ "$key" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$key" ]] && continue
  # Strip inline comments and whitespace from value
  value="${value%%#*}"
  value="${value%"${value##*[![:space:]]}"}"
  # Expand surrounding quotes if present
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  # Only export if the variable is not already set
  if [ -z "${!key+x}" ]; then
    export "$key=$value"
  fi
done < .env

# ---------------------------------------------------------------------------
# 2. Install deps if node_modules is missing
# ---------------------------------------------------------------------------

if [ ! -d node_modules ]; then
  echo "preview.sh: node_modules not found — running npm install"
  npm install --quiet
fi

# ---------------------------------------------------------------------------
# 3. Run Drizzle migrations
# ---------------------------------------------------------------------------

echo "preview.sh: applying database migrations"
npx drizzle-kit migrate

# ---------------------------------------------------------------------------
# 4. Run seed (idempotent)
# ---------------------------------------------------------------------------

echo "preview.sh: seeding database"
npm run seed

# ---------------------------------------------------------------------------
# 5. Start Next.js dev server, wait until ready, then print the URL and block
# ---------------------------------------------------------------------------
# Next.js prints "Ready in Xs" when it's fully bound. We wait for that line
# before emitting "http://localhost:3000" so the test knows the server is up.
# SIGTERM propagates to the npm child via the trap below.

NEXT_PID=""
FIFO=$(mktemp -t preview-fifo.XXXXXX)
rm -f "$FIFO"
mkfifo "$FIFO"

cleanup() {
  rm -f "$FIFO"
  if [ -n "$NEXT_PID" ]; then
    kill "$NEXT_PID" 2>/dev/null || true
    wait "$NEXT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT TERM INT

# Launch next dev; merge stdout+stderr into the FIFO.
npm run dev >"$FIFO" 2>&1 &
NEXT_PID=$!

URL_PRINTED=false

while IFS= read -r line; do
  echo "$line"
  # "Ready in Xs" appears when next dev has fully bound to the port.
  if [ "$URL_PRINTED" = false ] && echo "$line" | grep -qE "Ready in [0-9]"; then
    echo "http://localhost:3000"
    URL_PRINTED=true
  fi
done < "$FIFO"

rm -f "$FIFO"
wait "$NEXT_PID"
