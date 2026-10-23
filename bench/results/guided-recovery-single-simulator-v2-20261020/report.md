# Испытание процесса без модели

Результат: **PASS**; сценариев: 6.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `84e596b34ca79261e56380e13cc384091361a9d66785393227c6d9776f6013ab`.
Начало: 2026-10-20T04:56:24.427Z; конец: 2026-10-20T04:58:08.127Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v4-full-flow | [guided-v4-happy](traces/guided-v4-full-flow-guided-v4-happy.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-repair](traces/guided-v4-full-flow-guided-v4-repair.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-wrong-code](traces/guided-v4-full-flow-guided-v4-wrong-code.json) | Incorrect code rejected | blocked | PASS |
| guided-v4-full-flow | [guided-v4-resume](traces/guided-v4-full-flow-guided-v4-resume.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-repeated-op](traces/guided-v4-full-flow-guided-v4-repeated-op.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-manual-claim](traces/guided-v4-full-flow-guided-v4-manual-claim.json) | Full guided v4 reaches trusted handoff | handoff | PASS |

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
