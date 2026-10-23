# Испытание процесса без модели

Результат: **PASS**; сценариев: 7.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `1323e90c65d924f8bedc80b1e1c19d06cb2637733f00f230152255f93aa77bee`.
Начало: 2026-10-20T19:13:23.955Z; конец: 2026-10-20T19:14:33.716Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| state-first | [state-first-success](traces/state-first-state-first-success.json) | Канонический state и независимая изолированная приёмка | accepted | PASS |
| state-first | [state-first-wrong-code](traces/state-first-state-first-wrong-code.json) | Канонический state и независимая изолированная приёмка | rejected | PASS |
| state-first | [state-first-early-exit](traces/state-first-state-first-early-exit.json) | Канонический state и независимая изолированная приёмка | rejected | PASS |
| state-first | [state-first-protected-suite](traces/state-first-state-first-protected-suite.json) | Канонический state и независимая изолированная приёмка | rejected | PASS |
| state-first | [state-first-restart](traces/state-first-state-first-restart.json) | Канонический state и независимая изолированная приёмка | accepted | PASS |
| state-first | [state-first-stale-code](traces/state-first-state-first-stale-code.json) | Канонический state и независимая изолированная приёмка | accepted | PASS |
| state-first | [state-first-corrupt-state](traces/state-first-state-first-corrupt-state.json) | Канонический state и независимая изолированная приёмка | state-first: SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2) | PASS |

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
