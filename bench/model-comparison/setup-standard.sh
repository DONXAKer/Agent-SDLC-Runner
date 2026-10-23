#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
target=/var/tmp/sdlc-model-comparison-20261019
mkdir -p "$target"
export UV_CACHE_DIR="$target/uv-cache"
export UV_PYTHON_INSTALL_DIR="$PWD/python"
if [ ! -x "$target/env-standard/bin/python" ]; then
  ./uv-x86_64-unknown-linux-gnu/uv venv --python 3.12 "$target/env-standard"
fi
./uv-x86_64-unknown-linux-gnu/uv pip install --python "$target/env-standard/bin/python" --prerelease=allow 'sglang==0.5.20' 'nvidia-cuda-nvcc==13.0.88' 'nvidia-cuda-crt==13.0.88' 'nvidia-nvvm==13.0.88'
"$target/env-standard/bin/python" - <<'PY'
import json
import sys
from pathlib import Path
library = Path(sys.prefix) / 'lib/python3.12/site-packages/nvidia/cu13/lib'
for name, target in [('libcudart.so', library / 'libcudart.so.13'), ('libcuda.so', Path('/usr/lib/wsl/lib/libcuda.so.1'))]:
    if not target.exists():
        raise RuntimeError('Missing CUDA link target: ' + str(target))
    alias = library / name
    if alias.exists() or alias.is_symlink():
        if alias.resolve() != target.resolve():
            raise RuntimeError('Refusing to replace CUDA library alias: ' + str(alias))
    else:
        alias.symlink_to(target)
p=Path('runtime.json')
runtime=json.loads(p.read_text()) if p.exists() else {}
runtime['env-standard']='/var/tmp/sdlc-model-comparison-20261019/env-standard'
p.write_text(json.dumps(runtime,indent=2)+'\n')
PY
