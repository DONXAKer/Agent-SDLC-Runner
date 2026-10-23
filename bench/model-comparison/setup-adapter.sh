#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
target=/var/tmp/sdlc-model-comparison-20261019
mkdir -p "$target"
export UV_CACHE_DIR="$target/uv-cache"
export UV_PYTHON_INSTALL_DIR="$PWD/python"
if [ ! -x "$target/env-native/bin/python" ]; then
  ./uv-x86_64-unknown-linux-gnu/uv venv --python 3.12 "$target/env-native"
fi
./uv-x86_64-unknown-linux-gnu/uv pip install --python "$target/env-native/bin/python" './models/standard3/server[native-tokenizer]'
"$target/env-native/bin/python" - <<'PY'
import json
from pathlib import Path
p=Path('runtime.json')
runtime=json.loads(p.read_text()) if p.exists() else {}
runtime['env-native']='/var/tmp/sdlc-model-comparison-20261019/env-native'
p.write_text(json.dumps(runtime,indent=2)+'\n')
PY
