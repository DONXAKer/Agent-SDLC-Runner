#!/usr/bin/env bash
set -euo pipefail
pidfile="$1"
shift
printf '%s\n' "$$" > "$pidfile"
exec "$@"
