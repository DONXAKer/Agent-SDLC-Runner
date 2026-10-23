#!/usr/bin/env bash
set -euo pipefail
cd .tmp/model-comparison-20261019
export UV_CACHE_DIR=/var/tmp/sdlc-model-comparison-20261019/uv-cache
./uv-x86_64-unknown-linux-gnu/uv pip compile --python /var/tmp/sdlc-model-comparison-20261019/env-decision/bin/python --python-platform linux --format pylock.toml --output-file pylock.decision.toml ../../bench/model-comparison/decision-requirements.in --quiet
