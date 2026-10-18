# Короткий цикл: пилот

Статус: complete. Завершено 16/16.

| Режим | Задача | Повтор | Статус | Приёмка | Скрытые | Hidden outcome | Активных секунд |
|---|---|---:|---|---|---|---|---:|
| local | range-union | 1 | ready_for_review | true | 2/2 | pass | 114.8 |
| evidence | range-union | 1 | ready_for_review | true | 2/2 | pass | 132.4 |
| local | option-overlay | 1 | needs_input | false | 1/2 | fail | 101.0 |
| evidence | option-overlay | 1 | needs_input | false | 1/2 | fail | 141.9 |
| local | csv-cell | 1 | ready_for_review | true | 2/2 | pass | 68.9 |
| evidence | csv-cell | 1 | ready_for_review | true | 2/2 | pass | 59.4 |
| local | cent-split | 1 | ready_for_review | true | 2/2 | pass | 71.6 |
| evidence | cent-split | 1 | needs_input | false | 2/2 | pass | 104.6 |
| local | page-window | 1 | ready_for_review | true | 2/2 | pass | 109.9 |
| evidence | page-window | 1 | ready_for_review | true | 2/2 | pass | 114.5 |
| local | batch-outcomes | 1 | ready_for_review | true | 2/2 | pass | 83.3 |
| evidence | batch-outcomes | 1 | ready_for_review | true | 2/2 | pass | 105.4 |
| local | inventory-undo | 1 | ready_for_review | true | 2/2 | pass | 131.1 |
| evidence | inventory-undo | 1 | ready_for_review | true | 2/2 | pass | 120.3 |
| local | expiry-policy | 1 | ready_for_review | true | 2/2 | pass | 96.7 |
| evidence | expiry-policy | 1 | ready_for_review | true | 2/2 | pass | 126.7 |

- local/evidence share the model, checks and limits; evidence adds requirement-linked feedback only. Pilot enables maxUnchangedFailures=3 and maxRepeatedErrors=5 in both arms.
- Hidden cases and file obligations are evidence, not proof of every requirement. No default rollout based on this pilot.
- Unknown token costs stay unknown. Reference latency includes manual bridge handling.
