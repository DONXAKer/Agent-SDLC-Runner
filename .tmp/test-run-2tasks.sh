#!/usr/bin/env bash
set -uo pipefail
cd "D:/Проекты/Agent-SDLC-Runner"
echo "=== 1/4 gpt-oss / vat-rounding ==="
npm run bench -- --stage chunk --model ollama:gpt-oss-20b-agent-stepfill --task vat-rounding \
  --from-snapshot vat-rounding-plan --keep-workspace --slug testrun-gptoss-vat-rounding
echo "=== 2/4 gpt-oss / rename-field ==="
npm run bench -- --stage chunk --model ollama:gpt-oss-20b-agent-stepfill --task rename-field \
  --from-snapshot rename-field-plan --keep-workspace --slug testrun-gptoss-rename-field
echo "=== 3/4 ministral / vat-rounding ==="
npm run bench -- --stage chunk --model ollama:ministral3-14b-instruct-ctx32k-compactfill --task vat-rounding \
  --from-snapshot vat-rounding-plan --keep-workspace --slug testrun-ministral-vat-rounding
echo "=== 4/4 ministral / rename-field ==="
npm run bench -- --stage chunk --model ollama:ministral3-14b-instruct-ctx32k-compactfill --task rename-field \
  --from-snapshot rename-field-plan --keep-workspace --slug testrun-ministral-rename-field
echo "=== DONE ==="
