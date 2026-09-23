#!/usr/bin/env bash
# Compatibility entry point; startup logic lives in dev.mjs.
set -euo pipefail
exec node scripts/dev.mjs start "$@"
