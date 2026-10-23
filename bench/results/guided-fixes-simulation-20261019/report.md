# Испытание процесса без модели

Результат: **PASS**; сценариев: 29.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `b94ce2454cc4dde8e74c6a604292d7feadf8c88477a2dc73278815fac89e52a6`.
Начало: 2026-10-19T08:17:05.458Z; конец: 2026-10-19T08:20:17.347Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| task-loop | [task-success](traces/task-loop-task-success.json) | ready_for_review | ready_for_review | PASS |
| task-loop | [task-repair](traces/task-loop-task-repair.json) | ready_for_review | ready_for_review | PASS |
| task-loop | [task-fabricated-pass](traces/task-loop-task-fabricated-pass.json) | failed | failed | PASS |
| task-loop | [task-protected-tests](traces/task-loop-task-protected-tests.json) | failed | failed | PASS |
| task-loop | [task-outside-scope](traces/task-loop-task-outside-scope.json) | failed | failed | PASS |
| task-loop | [task-stale-evidence](traces/task-loop-task-stale-evidence.json) | failed | failed | PASS |
| task-loop | [task-repeated-failure-budget](traces/task-loop-task-repeated-failure-budget.json) | budget_exhausted | budget_exhausted | PASS |
| task-loop | [task-no-human-answer](traces/task-loop-task-no-human-answer.json) | needs_input | needs_input | PASS |
| task-loop | [task-environment-failure](traces/task-loop-task-environment-failure.json) | environment_error | environment_error | PASS |
| task-loop | [task-omitted-requirement](traces/task-loop-task-omitted-requirement.json) | failed | failed | PASS |
| guided | [guided-json-repair](traces/guided-guided-json-repair.json) | Повреждённый JSON исправлен одним повтором; ревью завершено | 1/1 фрагментов проверено | PASS |
| guided | [guided-json-rejected](traces/guided-guided-json-rejected.json) | Два повреждённых ответа оставляют ревью незавершённым | 0/1 фрагментов проверено | PASS |
| guided | [guided-research-resume](traces/guided-guided-research-resume.json) | После отмены переиспользуется первый файл; изменённый источник перечитывается | Разведка восстановлена; после изменения b.ts выполнен один новый запрос | PASS |
| guided | [guided-frozen-model-failures](traces/guided-guided-frozen-model-failures.json) | Записанные ошибки моделей отклонены текущими проверками контракта | Выдуманное исключение и потеря claim-5 обнаружены | PASS |
| full-flow | [full-flow-happy](traces/full-flow-full-flow-happy.json) | Доверенный verify и handoff; legacy v1, мелкий контур | handoff | PASS |
| full-flow | [full-flow-false-pass](traces/full-flow-full-flow-false-pass.json) | Блокировка неподтверждённого успеха | attempts-exhausted | PASS |
| full-flow | [full-flow-untrusted-handoff](traces/full-flow-full-flow-untrusted-handoff.json) | Блокировка неподтверждённого успеха | blocked | PASS |
| full-flow | [full-flow-resume](traces/full-flow-full-flow-resume.json) | Доверенный verify и handoff; legacy v1, мелкий контур | handoff | PASS |
| state-first | [state-first-success](traces/state-first-state-first-success.json) | Канонический state и независимая изолированная приёмка | accepted | PASS |
| state-first | [state-first-wrong-code](traces/state-first-state-first-wrong-code.json) | Канонический state и независимая изолированная приёмка | rejected | PASS |
| state-first | [state-first-early-exit](traces/state-first-state-first-early-exit.json) | Канонический state и независимая изолированная приёмка | rejected | PASS |
| state-first | [state-first-protected-suite](traces/state-first-state-first-protected-suite.json) | Канонический state и независимая изолированная приёмка | rejected | PASS |
| state-first | [state-first-restart](traces/state-first-state-first-restart.json) | Канонический state и независимая изолированная приёмка | accepted | PASS |
| state-first | [state-first-stale-code](traces/state-first-state-first-stale-code.json) | Канонический state и независимая изолированная приёмка | accepted | PASS |
| state-first | [state-first-corrupt-state](traces/state-first-state-first-corrupt-state.json) | Канонический state и независимая изолированная приёмка | state-first: SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2) | PASS |
| guided-v4-full-flow | [guided-v4-happy](traces/guided-v4-full-flow-guided-v4-happy.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-repair](traces/guided-v4-full-flow-guided-v4-repair.json) | Full guided v4 reaches trusted handoff | handoff | PASS |
| guided-v4-full-flow | [guided-v4-wrong-code](traces/guided-v4-full-flow-guided-v4-wrong-code.json) | Incorrect code rejected | blocked | PASS |
| guided-v4-full-flow | [guided-v4-resume](traces/guided-v4-full-flow-guided-v4-resume.json) | Full guided v4 reaches trusted handoff | handoff | PASS |

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
