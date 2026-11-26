#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-38422}"
BASE="http://127.0.0.1:${PORT}"
P_DB="orbit_pulsar_e2e_$$"
S_DB="orbit_saturn_e2e_$$"
PG_BASE="${PG_BASE:-postgres://localhost}"
ORBIT_BIN="${ORBIT_BIN:-}"
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
  rm -rf "$ROOT/storage/pulsar_e2e" "$ROOT/storage/saturn_e2e"
  dropdb --if-exists "$P_DB" >/dev/null 2>&1 || true
  dropdb --if-exists "$S_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb "$P_DB"
createdb "$S_DB"

export PULSAR_DATABASE_URL="${PG_BASE}/${P_DB}"
export SATURN_DATABASE_URL="${PG_BASE}/${S_DB}"
export FRONTEND_URL="$BASE"
export WEB_URL="$BASE"
export BIND="127.0.0.1:${PORT}"
export SECRET_KEY="orbit-e2e-secret-key"
export SECRET_KEY_BASE="orbit-e2e-secret-key-base"
export PULSAR_WEB_DIR="$ROOT/web/pulsar/build/client"
export SATURN_WEB_DIR="$ROOT/web/saturn"
export PULSAR_STORAGE_DIR="$ROOT/storage/pulsar_e2e"
export SATURN_STORAGE_DIR="$ROOT/storage/saturn_e2e"

if [[ -z "$ORBIT_BIN" ]]; then
  cargo build -p orbit
  ORBIT_BIN="$ROOT/target/debug/orbit"
fi

"$ORBIT_BIN" seed admin@orbit.local OrbitPass123! OrbitCo

"$ORBIT_BIN" >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

BASE="$BASE" OUT_DIR="$ROOT/docs/screenshots" node "$ROOT/tools/capture-screenshots.mjs" || {
  echo "--- orbit log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
}
