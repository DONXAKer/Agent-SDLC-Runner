# Испытание процесса без модели

Результат: **FAIL**; сценариев: 11.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `101c30cdff3ebc886b265a2c7988e98ee99db0fc90d9b83a9f0b929c13e31542`.
Начало: 2026-10-23T04:42:04.919Z; конец: 2026-10-23T04:42:27.963Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v5-full-flow | [guided-v5-happy](traces/guided-v5-full-flow-guided-v5-happy.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-repair](traces/guided-v5-full-flow-guided-v5-repair.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-wrong-code](traces/guided-v5-full-flow-guided-v5-wrong-code.json) | Incorrect code rejected | not started | FAIL |
| guided-v5-full-flow | [guided-v5-resume](traces/guided-v5-full-flow-guided-v5-resume.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-repeated-op](traces/guided-v5-full-flow-guided-v5-repeated-op.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-manual-claim](traces/guided-v5-full-flow-guided-v5-manual-claim.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-unfounded-rejection](traces/guided-v5-full-flow-guided-v5-unfounded-rejection.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-guided-protected](traces/guided-v5-full-flow-guided-v5-guided-protected.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-guided-restart](traces/guided-v5-full-flow-guided-v5-guided-restart.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-guided-stale](traces/guided-v5-full-flow-guided-v5-guided-stale.json) | Full guided v5 reaches trusted handoff | not started | FAIL |
| guided-v5-full-flow | [guided-v5-guided-red-acceptance](traces/guided-v5-full-flow-guided-v5-guided-red-acceptance.json) | Full guided v5 reaches trusted handoff | not started | FAIL |

## guided-v5-happy

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"e76e4db9-9830-4bd4-a69f-826ff84ab477"}}]

## guided-v5-repair

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"7b27ca6e-bd06-40a0-a780-dc866ba9dc7b"}}]

## guided-v5-wrong-code

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"a4b45b5e-fcc6-4180-a3b4-4334e70afaaa"}}]

## guided-v5-resume

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"e4fbd43d-74bf-46ee-b778-36a3fdc01b5a"}}]

## guided-v5-repeated-op

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"3c4f8165-6a79-43ff-9823-36d2d772ec44"}}]

## guided-v5-manual-claim

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"dc8ecb36-a805-4d79-b853-9e8c898df0db"}}]

## guided-v5-unfounded-rejection

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"fb2f078a-4669-4871-bea2-11eb1be65df9"}}]

## guided-v5-guided-protected

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"7c04c693-b836-437e-b41d-85f481857881"}}]

## guided-v5-guided-restart

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"7dffa80e-d02a-4333-898b-0f98f0507915"}}]

## guided-v5-guided-stale

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"34aa3676-6d6c-48b5-abc7-44a4c74b4661"}}]

## guided-v5-guided-red-acceptance

Первое нарушение: Current guided v4 preparation completes through approved Plan

- Error: [{"stage":"intent","chunk":1,"attempt":1,"ok":false,"note":"Error: Source file is missing","blockers":[],"timedOut":false,"skipped":false,"diagnostic":{"category":"stale","decisionId":"3fe80da1-d40e-47a7-9438-f52fa4bcc43e"}}]

Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
