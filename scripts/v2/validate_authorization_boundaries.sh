#!/usr/bin/env bash
set -u
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$PROJECT_ROOT" || exit 1
export TMPDIR="$PROJECT_ROOT/.codex-runtime/tmp"
export XDG_CACHE_HOME="$PROJECT_ROOT/.codex-runtime/cache"
export XDG_CONFIG_HOME="$PROJECT_ROOT/.codex-runtime/config"
export XDG_DATA_HOME="$PROJECT_ROOT/.codex-runtime/data"
export npm_config_cache="$XDG_CACHE_HOME/npm"
export npm_config_devdir="$PROJECT_ROOT/.codex-runtime/node-gyp"
export HARDHAT_DISABLE_TELEMETRY_PROMPT=true
export CI=true
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
REPORT="$PROJECT_ROOT/reproducibility/issue01-03-20261015"
mkdir -p "$REPORT"
failed=0
run_check() {
  name="$1"
  shift
  if "$@" > "$REPORT/$name.log" 2>&1; then code=0; else code=$?; failed=1; fi
  printf '%s\n' "$code" > "$REPORT/$name.exit"
  printf '%s: exit %s\n' "$name" "$code"
}
run_check compile node node_modules/hardhat/internal/cli/cli.js compile
run_check full-suite node node_modules/hardhat/internal/cli/cli.js test --no-compile
run_check original-circuit node scripts/v2/test_circuit_witness.js
run_check boundary-circuit node scripts/v2/test_authorization_circuit.js
printf '%s\n' "$failed" > "$REPORT/validation.exit"
exit "$failed"
