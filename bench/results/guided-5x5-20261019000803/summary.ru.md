# Guided 5x5 - summary

Catalog: `D:/Проекты/Agent-SDLC-Runner/bench/results/guided-5x5-20261019000803`
Series status: **completed** В· success **0/25** В· started `2026-10-18T23:08:10.791Z` В· finished `2026-10-19T01:03:18.494Z`

## By model

| Model | Success |
|---|---:|
| `ollama:devstral-small-2` | 0/5 |
| `ollama:mellum2-12b-instruct-q6` | 0/5 |
| `ollama:gpt-oss-20b-ctx32k` | 0/5 |
| `ollama:qwen3.8-27b-iq4-gpumax` | 0/5 |
| `ollama:ministral3-14b-instruct-ctx32k` | 0/5 |

## By task

| Task | Success |
|---|---:|
| `add-validator` | 0/5 |
| `config-default` | 0/5 |
| `rename-field` | 0/5 |
| `idempotent-retry` | 0/5 |
| `vat-rounding` | 0/5 |

## Cells

| Model | Task | Status | stopped | hidden | verdict |
|---|---|---|---|---|---|
| `ollama:devstral-small-2` | `add-validator` | no-result | - | - | - |
| `ollama:devstral-small-2` | `config-default` | no-result | - | - | - |
| `ollama:devstral-small-2` | `rename-field` | no-result | - | - | - |
| `ollama:devstral-small-2` | `idempotent-retry` | no-result | - | - | - |
| `ollama:devstral-small-2` | `vat-rounding` | no-result | - | - | - |
| `ollama:mellum2-12b-instruct-q6` | `add-validator` | failed | blocked | - | fail |
| `ollama:mellum2-12b-instruct-q6` | `config-default` | failed | blocked | - | fail |
| `ollama:mellum2-12b-instruct-q6` | `rename-field` | failed | blocked | - | fail |
| `ollama:mellum2-12b-instruct-q6` | `idempotent-retry` | failed | blocked | - | fail |
| `ollama:mellum2-12b-instruct-q6` | `vat-rounding` | failed | blocked | - | fail |
| `ollama:gpt-oss-20b-ctx32k` | `add-validator` | failed | blocked | - | fail |
| `ollama:gpt-oss-20b-ctx32k` | `config-default` | failed | blocked | - | fail |
| `ollama:gpt-oss-20b-ctx32k` | `rename-field` | failed | blocked | - | fail |
| `ollama:gpt-oss-20b-ctx32k` | `idempotent-retry` | failed | blocked | - | fail |
| `ollama:gpt-oss-20b-ctx32k` | `vat-rounding` | failed | blocked | - | fail |
| `ollama:qwen3.8-27b-iq4-gpumax` | `add-validator` | no-result | - | - | - |
| `ollama:qwen3.8-27b-iq4-gpumax` | `config-default` | failed | blocked | - | fail |
| `ollama:qwen3.8-27b-iq4-gpumax` | `rename-field` | failed | blocked | 2/6 | fail |
| `ollama:qwen3.8-27b-iq4-gpumax` | `idempotent-retry` | failed | blocked | - | fail |
| `ollama:qwen3.8-27b-iq4-gpumax` | `vat-rounding` | failed | blocked | - | fail |
| `ollama:ministral3-14b-instruct-ctx32k` | `add-validator` | failed | blocked | - | fail |
| `ollama:ministral3-14b-instruct-ctx32k` | `config-default` | failed | blocked | - | fail |
| `ollama:ministral3-14b-instruct-ctx32k` | `rename-field` | failed | blocked | - | fail |
| `ollama:ministral3-14b-instruct-ctx32k` | `idempotent-retry` | failed | blocked | - | fail |
| `ollama:ministral3-14b-instruct-ctx32k` | `vat-rounding` | failed | blocked | - | fail |
