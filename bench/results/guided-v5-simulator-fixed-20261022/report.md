# Испытание процесса без модели

Результат: **FAIL**; сценариев: 11.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `894e1e25f5e1292875b35fa4d2b7e4e08c4028e3c97c904f45c34a8c3faed2f9`.
Начало: 2026-10-22T21:18:16.139Z; конец: 2026-10-22T21:21:13.077Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v5-full-flow | [guided-v4-happy](traces/guided-v5-full-flow-guided-v4-happy.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-repair](traces/guided-v5-full-flow-guided-v4-repair.json) | Full guided v4 reaches trusted handoff | handoff | FAIL |
| guided-v5-full-flow | [guided-v4-wrong-code](traces/guided-v5-full-flow-guided-v4-wrong-code.json) | Incorrect code rejected | blocked | PASS |
| guided-v5-full-flow | [guided-v4-resume](traces/guided-v5-full-flow-guided-v4-resume.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-repeated-op](traces/guided-v5-full-flow-guided-v4-repeated-op.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-manual-claim](traces/guided-v5-full-flow-guided-v4-manual-claim.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-unfounded-rejection](traces/guided-v5-full-flow-guided-v4-unfounded-rejection.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-guided-protected](traces/guided-v5-full-flow-guided-v4-guided-protected.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-guided-restart](traces/guided-v5-full-flow-guided-v4-guided-restart.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v5-full-flow | [guided-v4-guided-stale](traces/guided-v5-full-flow-guided-v4-guided-stale.json) | Full guided v4 reaches trusted handoff | snapshot-point | PASS |
| guided-v5-full-flow | [guided-v4-guided-red-acceptance](traces/guided-v5-full-flow-guided-v4-guided-red-acceptance.json) | Full guided v4 reaches trusted handoff | blocked | PASS |

## guided-v4-repair

Первое нарушение: Malformed field response is rejected before a valid repair


Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
