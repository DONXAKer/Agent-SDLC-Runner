# LM Studio model diagnostics — 2026-09-30

Run against locally installed models through `http://localhost:1434/v1`. One repeat per available diagnostic case; per-case timeout 2 minutes. `bench:diagnose` performs its own environment/model preflight before starting cases.

| Model profile | Preflight exit | Measured / available | Findings | Timed out | Report |
|---|---:|---:|---:|---:|---|
| lmstudio:gemma-4-e4b-stepfill | 0 | 7/7 | 7 | 2 | `diagnostics-lmstudio-gemma-4-e4b-stepfill-1790745267591.json` |
| lmstudio:gemma4-12b-stepfill | 0 | 7/7 | 7 | 2 | `diagnostics-lmstudio-gemma4-12b-stepfill-1790745693762.json` |
| lmstudio:qwen3-8b-stepfill | 0 | 7/7 | 7 | 2 | `diagnostics-lmstudio-qwen3-8b-stepfill-1790745985946.json` |
| lmstudio:qwen3-coder-30b-stepfill | 0 | 7/7 | 7 | 1 | `diagnostics-lmstudio-qwen3-coder-30b-stepfill-1790746219015.json` |
| lmstudio:gpt-oss-20b-f16 | 0 | 7/7 | 7 | 2 | `diagnostics-lmstudio-gpt-oss-20b-f16-1790746545768.json` |
| lmstudio:glm-4.7-flash-zaiorg | 0 | 7/7 | 7 | 2 | `diagnostics-lmstudio-glm-4-7-flash-zaiorg-1790746859507.json` |
| lmstudio:qwen38-27b-stepfill | 1 | 0/7 | 0 | 0 | `diagnostics-lmstudio-qwen38-27b-stepfill-1790747122080.json` |

Six models passed preflight and produced 42 case samples (7 available cases each). All samples were mechanically marked with findings; 11 hit the configured timeout. This is not a semantic correctness score. Qwen3.8 27B loaded with 80% GPU offload after full offload exceeded the estimated 20.21 GiB; its diagnostic preflight returned exit code 1, so no cases ran.
