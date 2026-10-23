# Испытание процесса без модели

Результат: **PASS**; сценариев: 4.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `32908ec19a3977956e2f39006a76b4d40386ae459aa823275e795ae2f466a9ef`.
Начало: 2026-10-19T08:35:25.934Z; конец: 2026-10-19T08:36:24.597Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v4-full-flow | [guided-v4-happy](traces/guided-v4-full-flow-guided-v4-happy.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-repair](traces/guided-v4-full-flow-guided-v4-repair.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-wrong-code](traces/guided-v4-full-flow-guided-v4-wrong-code.json) | Incorrect code rejected | blocked | PASS |
| guided-v4-full-flow | [guided-v4-resume](traces/guided-v4-full-flow-guided-v4-resume.json) | Full guided v4 reaches trusted handoff | handoff | PASS |

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
