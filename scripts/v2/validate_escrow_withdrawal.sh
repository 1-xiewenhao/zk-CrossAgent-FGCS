#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export TMPDIR="$PWD/.codex-runtime/tmp"
export XDG_CACHE_HOME="$PWD/.codex-runtime/cache"
export XDG_CONFIG_HOME="$PWD/.codex-runtime/config"
export XDG_DATA_HOME="$PWD/.codex-runtime/data"
export npm_config_cache="$PWD/.codex-runtime/cache/npm"
export npm_config_devdir="$PWD/.codex-runtime/node-gyp"
export HARDHAT_DISABLE_TELEMETRY_PROMPT=true CI=true
export JNCA_PROOF_OUTPUT="reproducibility/issue05-20261015/fresh-proof"
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
node node_modules/hardhat/internal/cli/cli.js compile
node node_modules/hardhat/internal/cli/cli.js test --no-compile
