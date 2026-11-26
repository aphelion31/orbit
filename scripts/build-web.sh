#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/web/pulsar"
bun install --frozen-lockfile
bun run typecheck
bun run build
