# Task-loop: 5 моделей × 5 задач

- Модели: devstral-small-2, mellum2-12b-instruct-q6, gpt-oss-20b-ctx32k, qwen3.8-27b-iq4-gpumax, ministral3-14b-instruct-ctx32k
- Задачи: range-union, option-overlay, csv-cell, cent-split, page-window
- Arm: local, repeats: 1 → 25 ячеек
- Кейсы: bench/experiments/task-loop-recent-5tasks.json
- Остановка: STOP_AFTER_CURRENT в этом каталоге
- После фиксов AskHuman / public-api / requireNewTest / ProviderEnv retry
