#!/usr/bin/env bash
set -euo pipefail
export HF_HUB_OFFLINE=1
export HF_HOME="$(pwd)/.tmp/model-comparison-20261019/hf-cache"
export CUDA_VISIBLE_DEVICES=0
exec /var/tmp/sdlc-model-comparison-20261019/env-standard/bin/python -m sglang.launch_server --model-path .tmp/model-comparison-20261019/models/standard3 --served-model-name standard3 --host 127.0.0.1 --port 30000 --tp-size 1 --model-impl sglang --dtype bfloat16 --context-length 32768 --max-running-requests 1 --mem-fraction-static 0.8 --chunked-prefill-size -1 --disable-radix-cache --mm-preprocess-cache-size-mb 0 --model-config-parser hf --load-format safetensors
