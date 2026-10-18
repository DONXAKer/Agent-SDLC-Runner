# Guided 5×5: полный флоу Agent-SDLC

- Те же 5 моделей, что task-loop-recent5x5
- Задачи registry (не evidence-*): add-validator, config-default, rename-field, idempotent-retry, vat-rounding
- guided v4, preparation 3, 1 повтор → 25 ячеек
- stage 20 мин / run 45 мин
- Остановка: STOP_AFTER_CURRENT
- Сравнение: node .tmp/compare-short-vs-guided.mjs bench/results/task-loop-recent5x5-20261015004712 --guided bench/results/guided-5x5-20261015093908
