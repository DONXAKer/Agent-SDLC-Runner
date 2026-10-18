# Выводы: последние модели × 2 задачи

Каталог: `bench/results/task-loop-recent-20261014225759`.
Arm: `local`, repeats: 1. Задачи: `range-union`, `csv-cell`.

## Итог по моделям

| Модель | Приёмка | range-union | csv-cell |
|---|---:|---|---|
| gpt-oss-20b-ctx32k | 2/2 | ready + hidden pass | ready + hidden pass |
| qwen3.8-27b-iq4-gpumax | 2/2 | ready + hidden pass | ready + hidden pass |
| mellum2-12b-instruct-q6 | 1/2 | needs_input, hidden fail | ready + hidden pass |
| devstral-small-2 | 1/2 | ready + hidden pass | budget_exhausted, hidden fail |
| ministral3-14b-instruct-ctx32k (1-й) | 0/2 | environment_error (Ollama HTTP 500) | environment_error (Ollama HTTP 500; hidden pass) |
| ministral3-14b-instruct-ctx32k (retry) | 0/2 | ready_for_review, acceptance=false, hidden pass | environment_error снова |

## Наблюдения

- Две модели закрыли обе задачи на автоприёмке: **gpt-oss-20b-ctx32k** и **qwen3.8-27b-iq4-gpumax**.
- Mellum2: на range-union ушла в `needs_input`; csv-cell прошла.
- Devstral: range-union прошла; csv-cell исчерпала бюджет без приёмки.
- Ministral нестабильна на Ollama: первый прогон — обе ячейки `ProviderEnvError` (HTTP 500, битый escape в JSON). Retry (`ollama_ministral3-14b-instruct-ctx32k-retry/`): range-union дошла до ready без автоприёмки (hidden pass), csv-cell снова environment_error. Надёжного вердикта по Ministral на этих двух задачах нет.

Ограничения: одна повторность, две задачи, без evidence-arm; не статистика и не default rollout.
