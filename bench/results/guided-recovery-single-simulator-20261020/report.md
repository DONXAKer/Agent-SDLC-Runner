# Испытание процесса без модели

Результат: **PASS**; сценариев: 4.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `c6e32180515057875a2249c1e7b241fb9f3dd84d64e9e8d08408d3d949f53d08`.
Начало: 2026-10-20T04:53:28.226Z; конец: 2026-10-20T04:55:02.889Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v4-full-flow | [guided-v4-happy](traces/guided-v4-full-flow-guided-v4-happy.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-repair](traces/guided-v4-full-flow-guided-v4-repair.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-wrong-code](traces/guided-v4-full-flow-guided-v4-wrong-code.json) | Incorrect code rejected | blocked | PASS |
| guided-v4-full-flow | [guided-v4-resume](traces/guided-v4-full-flow-guided-v4-resume.json) | Full guided v4 reaches trusted handoff | handoff | PASS |

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
