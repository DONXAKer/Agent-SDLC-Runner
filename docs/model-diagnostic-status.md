# Статус диагностики локальных моделей

Срез: 2026-09-30 · доступно кейсов: 8/15 · нет входных снимков: E02, A01, A02, P01, P02, H01, H02.

| Модель | Preflight | Запущено / доступно | Таймауты | Verify-дефекты пойманы | Проблемы | Смысловая оценка |
|---|---:|---:|---:|---:|---|---|
| [lmstudio:gemma-4-e4b-stepfill](../bench/results/diagnostics-lmstudio-gemma-4-e4b-stepfill-1790745267591.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [lmstudio:gemma4-12b-stepfill](../bench/results/diagnostics-lmstudio-gemma4-12b-stepfill-1790745693762.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [lmstudio:glm-4.7-flash-zaiorg](../bench/results/diagnostics-lmstudio-glm-4-7-flash-zaiorg-1790746859507.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [lmstudio:gpt-oss-20b-f16](../bench/results/diagnostics-lmstudio-gpt-oss-20b-f16-1790746545768.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [lmstudio:qwen3-8b-stepfill](../bench/results/diagnostics-lmstudio-qwen3-8b-stepfill-1790745985946.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [lmstudio:qwen3-coder-30b-stepfill](../bench/results/diagnostics-lmstudio-qwen3-coder-30b-stepfill-1790746219015.report.md) | PASS | 2/8 | 1 | не измерено | TIMEOUT (1); STAGE_FAILED (1); INPUT_BLOCKED (5) | not assessed |
| [lmstudio:qwen38-27b-stepfill](../bench/results/diagnostics-lmstudio-qwen38-27b-stepfill-1790747122080.report.md) | FAIL 1 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:apriel-1.6-15b](../bench/results/diagnostics-ollama-apriel-1-6-15b-1790750638861.report.md) | CRASH 3221226505 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:cline_roocode:8b-ctx16k](../bench/results/diagnostics-ollama-cline_roocode-8b-ctx16k-1790744581423.report.md) | PASS | 2/8 | 1 | не измерено | TIMEOUT (1); STAGE_FAILED (1); INPUT_BLOCKED (5) | not assessed |
| [ollama:devstral-small-2](../bench/results/diagnostics-ollama-devstral-small-2-1790748300810.report.md) | CRASH 3221226505 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:gemma4-12b](../bench/results/diagnostics-ollama-gemma4-12b-1790749779672.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:gemma4-12b-ctx32k-nofill](../bench/results/diagnostics-ollama-gemma4-12b-ctx32k-nofill-1790750168625.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:gpt-oss-20b](../bench/results/diagnostics-ollama-gpt-oss-20b-1790748268241.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:gpt-oss-20b-compactfill](../bench/results/diagnostics-ollama-gpt-oss-20b-compactfill-1790765747874.report.md) | FAIL 2 | 0/8 | 0 | не измерено | ENV: движок не ответил на прогрев: движок не ответил на прогрев за 120000 мс; перезагрузить движок и повторить прогрев может преполёт с явным --engine-reload | not run |
| [ollama:gpt-oss-20b-ctx32k](../bench/results/diagnostics-ollama-gpt-oss-20b-ctx32k-1790750528927.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:granite-4.0-h-tiny](../bench/results/diagnostics-ollama-granite-4-0-h-tiny-1790749357771.report.md) | FAIL 1 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:granite4.2-8b](../bench/results/diagnostics-ollama-granite4-2-8b-1790748762409.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:granite4.2-8b-ctx32k](../bench/results/diagnostics-ollama-granite4-2-8b-ctx32k-1790749260370.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:granite4.2-8b-ctx32k-compactfill](../bench/results/diagnostics-ollama-granite4-2-8b-ctx32k-compactfill-1790770172557.report.md) | FAIL 1 | 0/8 | 0 | не измерено | MODEL: вызова нет, текст: «» (провал в 2/2 попыток) | not run |
| [ollama:lfm2.5-8b-a1b](../bench/results/diagnostics-ollama-lfm2-5-8b-a1b-1790750723874.report.md) | FAIL 1 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:ministral3-14b-instruct](../bench/results/diagnostics-ollama-ministral3-14b-instruct-1790750842133.report.md) | FAIL 1 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:ministral3-14b-instruct-ctx32k](../bench/results/diagnostics-ollama-ministral3-14b-instruct-ctx32k-1790751147926.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:ornith-1.5-9b](../bench/results/diagnostics-ollama-ornith-1-5-9b-1790750607933.report.md) | FAIL 1 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:qwen3-8b-ctx32k-stepfill-compactfill](../bench/results/diagnostics-ollama-qwen3-8b-ctx32k-stepfill-compactfill-1790769863252.report.md) | PASS | 8/8 | 0 | 0/2 | STAGE_FAILED (4); HIDDEN_TEST_FAILED (1); SEED_MISSED (2) | not assessed |
| [ollama:qwen3-coder-30b-ctx32k-stepfill-compactfill](../bench/results/diagnostics-ollama-qwen3-coder-30b-ctx32k-stepfill-compactfill-1790751634149.report.md) | CRASH 3221226505 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:qwen3:8b-ctx16k](../bench/results/diagnostics-ollama-qwen3-8b-ctx16k-1790747897422.report.md) | PASS | 2/8 | 2 | не измерено | TIMEOUT (2); INPUT_BLOCKED (5) | not assessed |
| [ollama:qwen3.6:35b-a3b](../bench/results/diagnostics-ollama-qwen3-6-35b-a3b-1790765386691.report.md) | FAIL 1 | 0/8 | 0 | не измерено | INPUT_INVALID (1) | not run |
| [ollama:qwen3.8-27b](../bench/results/diagnostics-ollama-qwen3-8-27b-1790750212445.report.md) | CRASH 3221226505 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:qwen3.8-27b-iq4](../bench/results/diagnostics-ollama-qwen3-8-27b-iq4-1790750761168.report.md) | CRASH 3221226505 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
| [ollama:qwen3.8-27b-iq4-ctx16k](../bench/results/diagnostics-ollama-qwen3-8-27b-iq4-ctx16k-1790750790788.report.md) | CRASH 3221226505 | 0/8 | 0 | не измерено | preflight; см. отчёт | not run |
