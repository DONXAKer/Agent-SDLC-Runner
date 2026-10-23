#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
target=/var/tmp/sdlc-model-comparison-20261019
case "$target" in /var/tmp/sdlc-model-comparison-20261019) ;; *) exit 2 ;; esac
mkdir -p "$target"
for name in "$@"; do
  case "$name" in env-decision|env-standard|env-native) ;; *) exit 2 ;; esac
  test -x "$name/bin/python"
  mkdir -p "$target/$name"
  cp -R --no-preserve=all "$name/." "$target/$name/"
  "$target/$name/bin/python" -c 'import sys; print(sys.prefix)'
done
"$target/${1}/bin/python" - "$@" <<'PY'
import json
from pathlib import Path
import sys
p = Path('runtime.json')
runtime = json.loads(p.read_text()) if p.exists() else {}
for name in sys.argv[1:]:
    runtime[name] = '/var/tmp/sdlc-model-comparison-20261019/' + name
p.write_text(json.dumps(runtime, indent=2) + '\n')
PY
