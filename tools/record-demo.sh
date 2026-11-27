#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-38423}"
BASE="http://127.0.0.1:${PORT}"
P_DB="orbit_pulsar_demo_$$"
S_DB="orbit_saturn_demo_$$"
PG_BASE="${PG_BASE:-postgres://localhost}"
ORBIT_BIN="${ORBIT_BIN:-}"
OUT_DIR="${OUT_DIR:-/tmp/orbit-readme-assets}"
RAW_DIR="$(mktemp -d)"
LOG="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$RAW_DIR" "$LOG" "$ROOT/storage/pulsar_demo" "$ROOT/storage/saturn_demo"
  dropdb --if-exists "$P_DB" >/dev/null 2>&1 || true
  dropdb --if-exists "$S_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"
createdb "$P_DB"
createdb "$S_DB"

export PULSAR_DATABASE_URL="${PG_BASE}/${P_DB}"
export SATURN_DATABASE_URL="${PG_BASE}/${S_DB}"
export FRONTEND_URL="$BASE"
export WEB_URL="$BASE"
export BIND="127.0.0.1:${PORT}"
export SECRET_KEY="orbit-demo-secret-key"
export SECRET_KEY_BASE="orbit-demo-secret-key-base"
export PULSAR_WEB_DIR="$ROOT/web/pulsar/build/client"
export SATURN_WEB_DIR="$ROOT/web/saturn"
export PULSAR_STORAGE_DIR="$ROOT/storage/pulsar_demo"
export SATURN_STORAGE_DIR="$ROOT/storage/saturn_demo"

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

BASE="$BASE" RAW_DIR="$RAW_DIR" node "$ROOT/tools/record-demo.mjs" || {
  echo "--- orbit log ---" >&2
  cat "$LOG" >&2 || true
  exit 1
}

FRAMES_TXT="$RAW_DIR/frames.txt"
[[ -f "$FRAMES_TXT" ]] || { echo "Missing recorded $FRAMES_TXT" >&2; exit 1; }

MP4_OUT="$OUT_DIR/orbit-demo.mp4"
GIF_OUT="$OUT_DIR/orbit-demo.gif"
PALETTE="$RAW_DIR/palette.png"

ffmpeg -y -f concat -safe 0 -i "$FRAMES_TXT" \
  -vf "fps=30,scale=1280:800:flags=lanczos" \
  -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -movflags +faststart \
  "$MP4_OUT"

ffmpeg -y -f concat -safe 0 -i "$FRAMES_TXT" \
  -vf "fps=10,scale=920:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff" \
  "$PALETTE"

ffmpeg -y -f concat -safe 0 -i "$FRAMES_TXT" -i "$PALETTE" \
  -lavfi "fps=10,scale=920:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a" \
  "$GIF_OUT"

echo "✔ Rendered demo assets:"
ls -lh "$MP4_OUT" "$GIF_OUT"
