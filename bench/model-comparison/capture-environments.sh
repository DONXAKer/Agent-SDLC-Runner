#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
target=/var/tmp/sdlc-model-comparison-20261019
for name in env-decision env-standard env-native; do
  test -x "$target/$name/bin/python"
  ./uv-x86_64-unknown-linux-gnu/uv pip check --python "$target/$name/bin/python"
  ./uv-x86_64-unknown-linux-gnu/uv pip freeze --python "$target/$name/bin/python" > "$name.freeze.txt"
done
"$target/env-decision/bin/python" - <<'PY'
import json
from pathlib import Path
runtime={name:'/var/tmp/sdlc-model-comparison-20261019/'+name for name in ['env-decision','env-standard','env-native']}
Path('runtime.json').write_text(json.dumps(runtime,indent=2)+'\n')
PY
