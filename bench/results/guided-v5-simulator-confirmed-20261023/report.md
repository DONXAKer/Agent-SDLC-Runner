# Испытание процесса без модели

Результат: **PASS**; сценариев: 11.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `c7b9575c261a0c55febb1b946c21eb0f2c4ac6daded941b0917a0241605ed921`.
Начало: 2026-10-23T04:49:37.762Z; конец: 2026-10-23T04:51:50.138Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v5-full-flow | [guided-v5-happy](traces/guided-v5-full-flow-guided-v5-happy.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-repair](traces/guided-v5-full-flow-guided-v5-repair.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-wrong-code](traces/guided-v5-full-flow-guided-v5-wrong-code.json) | Incorrect code rejected | blocked | PASS |
| guided-v5-full-flow | [guided-v5-resume](traces/guided-v5-full-flow-guided-v5-resume.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-repeated-op](traces/guided-v5-full-flow-guided-v5-repeated-op.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-manual-claim](traces/guided-v5-full-flow-guided-v5-manual-claim.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-unfounded-rejection](traces/guided-v5-full-flow-guided-v5-unfounded-rejection.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-guided-protected](traces/guided-v5-full-flow-guided-v5-guided-protected.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-guided-restart](traces/guided-v5-full-flow-guided-v5-guided-restart.json) | Full guided v5 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v5-guided-stale](traces/guided-v5-full-flow-guided-v5-guided-stale.json) | Full guided v5 reaches trusted handoff | snapshot-point | PASS |
| guided-v5-full-flow | [guided-v5-guided-red-acceptance](traces/guided-v5-full-flow-guided-v5-guided-red-acceptance.json) | Full guided v5 reaches trusted handoff | blocked | PASS |

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
