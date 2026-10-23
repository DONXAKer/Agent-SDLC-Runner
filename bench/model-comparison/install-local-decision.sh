#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
target=/var/tmp/sdlc-model-comparison-20261019
export UV_CACHE_DIR="$target/uv-cache"
"$target/env-decision/bin/python" - <<'PY'
import json
from pathlib import Path
expected=json.loads(Path('decision-wheels.json').read_text())
verified=json.loads(Path('wheels-verified.json').read_text())
assert len(expected)==len(verified)==55
assert {p['name'] for p in expected}=={p['name'] for p in verified}
for p in verified:
    assert (Path('wheels')/p['file']).stat().st_size==p['bytes']
PY
./uv-x86_64-unknown-linux-gnu/uv pip install --python "$target/env-decision/bin/python" --no-index --find-links "$PWD/wheels" -r ../../bench/model-comparison/decision-requirements.in
"$target/env-decision/bin/python" -c 'import torch,transformers; print(torch.__version__, transformers.__version__, torch.cuda.is_available())'
"$target/env-decision/bin/python" - <<'PY'
import json
from pathlib import Path
p=Path('runtime.json')
runtime=json.loads(p.read_text()) if p.exists() else {}
runtime['env-decision']='/var/tmp/sdlc-model-comparison-20261019/env-decision'
p.write_text(json.dumps(runtime,indent=2)+'\n')
PY
