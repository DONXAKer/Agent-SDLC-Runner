# Короткий цикл: пилот

Статус: partial. Завершено 1/48.

| Режим | Задача | Повтор | Статус | Приёмка | Скрытые | Hidden outcome | Активных секунд |
|---|---|---:|---|---|---|---|---:|
| local | range-union | 1 | environment_error | — | — | — | — |
| evidence | range-union | 1 | pending | — | — | — | — |
| local | option-overlay | 1 | pending | — | — | — | — |
| evidence | option-overlay | 1 | pending | — | — | — | — |
| local | csv-cell | 1 | pending | — | — | — | — |
| evidence | csv-cell | 1 | pending | — | — | — | — |
| local | cent-split | 1 | pending | — | — | — | — |
| evidence | cent-split | 1 | pending | — | — | — | — |
| local | page-window | 1 | pending | — | — | — | — |
| evidence | page-window | 1 | pending | — | — | — | — |
| local | batch-outcomes | 1 | pending | — | — | — | — |
| evidence | batch-outcomes | 1 | pending | — | — | — | — |
| local | inventory-undo | 1 | pending | — | — | — | — |
| evidence | inventory-undo | 1 | pending | — | — | — | — |
| local | expiry-policy | 1 | pending | — | — | — | — |
| evidence | expiry-policy | 1 | pending | — | — | — | — |
| evidence | range-union | 2 | pending | — | — | — | — |
| local | range-union | 2 | pending | — | — | — | — |
| evidence | option-overlay | 2 | pending | — | — | — | — |
| local | option-overlay | 2 | pending | — | — | — | — |
| evidence | csv-cell | 2 | pending | — | — | — | — |
| local | csv-cell | 2 | pending | — | — | — | — |
| evidence | cent-split | 2 | pending | — | — | — | — |
| local | cent-split | 2 | pending | — | — | — | — |
| evidence | page-window | 2 | pending | — | — | — | — |
| local | page-window | 2 | pending | — | — | — | — |
| evidence | batch-outcomes | 2 | pending | — | — | — | — |
| local | batch-outcomes | 2 | pending | — | — | — | — |
| evidence | inventory-undo | 2 | pending | — | — | — | — |
| local | inventory-undo | 2 | pending | — | — | — | — |
| evidence | expiry-policy | 2 | pending | — | — | — | — |
| local | expiry-policy | 2 | pending | — | — | — | — |
| local | range-union | 3 | pending | — | — | — | — |
| evidence | range-union | 3 | pending | — | — | — | — |
| local | option-overlay | 3 | pending | — | — | — | — |
| evidence | option-overlay | 3 | pending | — | — | — | — |
| local | csv-cell | 3 | pending | — | — | — | — |
| evidence | csv-cell | 3 | pending | — | — | — | — |
| local | cent-split | 3 | pending | — | — | — | — |
| evidence | cent-split | 3 | pending | — | — | — | — |
| local | page-window | 3 | pending | — | — | — | — |
| evidence | page-window | 3 | pending | — | — | — | — |
| local | batch-outcomes | 3 | pending | — | — | — | — |
| evidence | batch-outcomes | 3 | pending | — | — | — | — |
| local | inventory-undo | 3 | pending | — | — | — | — |
| evidence | inventory-undo | 3 | pending | — | — | — | — |
| local | expiry-policy | 3 | pending | — | — | — | — |
| evidence | expiry-policy | 3 | pending | — | — | — | — |

- local/evidence share the model, checks and limits; evidence adds requirement-linked feedback only. Pilot enables maxUnchangedFailures=3 and maxRepeatedErrors=5 in both arms.
- Hidden cases and file obligations are evidence, not proof of every requirement. No default rollout based on this pilot.
- Unknown token costs stay unknown. Reference latency includes manual bridge handling.
