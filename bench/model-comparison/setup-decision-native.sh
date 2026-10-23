#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
target=/var/tmp/sdlc-model-comparison-20261019
mkdir -p "$target"
export UV_CACHE_DIR="$target/uv-cache"
export UV_PYTHON_INSTALL_DIR="$PWD/python"
if [ ! -x "$target/env-decision/bin/python" ]; then
  ./uv-x86_64-unknown-linux-gnu/uv venv --python 3.12 "$target/env-decision"
fi
./uv-x86_64-unknown-linux-gnu/uv pip install --python "$target/env-decision/bin/python" -r ../../bench/model-comparison/decision-requirements.in
"$target/env-decision/bin/python" -c 'import torch,transformers; print(torch.__version__, transformers.__version__, torch.cuda.is_available())'
"$target/env-decision/bin/python" - <<'PY'
import json
from pathlib import Path
p=Path('runtime.json')
runtime=json.loads(p.read_text()) if p.exists() else {}
runtime['env-decision']='/var/tmp/sdlc-model-comparison-20261019/env-decision'
p.write_text(json.dumps(runtime,indent=2)+'\n')
PY
