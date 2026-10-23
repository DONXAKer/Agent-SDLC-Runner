# Испытание процесса без модели

Результат: **FAIL**; сценариев: 11.

PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.
TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.
Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.

Runner: `06e6e0d897c344ae5c8de159bc01ebe3994cf631` + незакоммиченные изменения; Node: v24.18.0.
SHA-256 исходников и сценариев: `91fbef004266c3575de589470360c9bbd70f8dddce50a64552d46ce7387c2629`.
Начало: 2026-10-22T19:35:28.653Z; конец: 2026-10-22T19:39:39.126Z.

| Контур | Сценарий | Ожидание | Наблюдение | Итог |
|---|---|---|---|---|
| guided-v5-full-flow | [guided-v4-happy](traces/guided-v5-full-flow-guided-v4-happy.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-repair](traces/guided-v5-full-flow-guided-v4-repair.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-wrong-code](traces/guided-v5-full-flow-guided-v4-wrong-code.json) | Incorrect code rejected | stage-timeout | PASS |
| guided-v5-full-flow | [guided-v4-resume](traces/guided-v5-full-flow-guided-v4-resume.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-repeated-op](traces/guided-v5-full-flow-guided-v4-repeated-op.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-manual-claim](traces/guided-v5-full-flow-guided-v4-manual-claim.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-unfounded-rejection](traces/guided-v5-full-flow-guided-v4-unfounded-rejection.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-guided-protected](traces/guided-v5-full-flow-guided-v4-guided-protected.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-guided-restart](traces/guided-v5-full-flow-guided-v4-guided-restart.json) | Full guided v4 reaches trusted handoff | blocked | FAIL |
| guided-v5-full-flow | [guided-v4-guided-stale](traces/guided-v5-full-flow-guided-v4-guided-stale.json) | Full guided v4 reaches trusted handoff | snapshot-point | PASS |
| guided-v5-full-flow | [guided-v4-guided-red-acceptance](traces/guided-v5-full-flow-guided-v4-guided-red-acceptance.json) | Full guided v4 reaches trusted handoff | blocked | PASS |

## guided-v4-happy

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"state-first: документ собирается по структурированным записям ревью — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","в отчёте нет строк по пунктам задачи: claim-1, claim-2, claim-3, claim-4, claim-5 — каждый считается ⚠","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


## guided-v4-repair

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"state-first: документ собирается по структурированным записям ревью — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","в отчёте нет строк по пунктам задачи: claim-1, claim-2, claim-3, claim-4, claim-5 — каждый считается ⚠","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}

- Malformed field response is rejected before a valid repair

## guided-v4-resume

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"state-first: документ собирается по структурированным записям ревью — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","в отчёте нет строк по пунктам задачи: claim-1, claim-2, claim-3, claim-4, claim-5 — каждый считается ⚠","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


## guided-v4-repeated-op

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"state-first: документ собирается по структурированным записям ревью — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","в отчёте нет строк по пунктам задачи: claim-1, claim-2, claim-3, claim-4, claim-5 — каждый считается ⚠","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


## guided-v4-manual-claim

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"state-first: документ собирается по структурированным записям ревью — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","в отчёте нет строк по пунктам задачи: claim-1, claim-2, claim-3, claim-4, claim-5 — каждый считается ⚠","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


## guided-v4-unfounded-rejection

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"state-first: документ собирается по структурированным записям ревью — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","в отчёте нет строк по пунктам задачи: claim-1, claim-2, claim-3, claim-4, claim-5 — каждый считается ⚠","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


## guided-v4-guided-protected

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"ход модели пропущен: reviewFill прошёл конвейер целиком — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


## guided-v4-guided-restart

Первое нарушение: Verify and Handoff finish with a trusted verdict: {"stages":[{"stage":"verify","chunk":1,"attempt":1,"ok":true,"note":"ход модели пропущен: reviewFill прошёл конвейер целиком — отчёт закрывается его записями, добором по пунктам приёмки и дозаполнением по полям, без второго свободного прохода по тому же diff'у","blockers":[],"timedOut":false,"skipped":false},{"stage":"handoff","chunk":1,"attempt":1,"ok":false,"note":"Передаче недостаёт 4 проверенных фактов; требуется ввод или актуальные артефакты","blockers":[],"timedOut":false,"skipped":false,"modelRequests":0,"closedBy":"runtime"}],"finalVerdict":{"passed":true,"action":"continue","reasons":["сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает","посевом не проверялись гейты: Сборка, Тесты, Scope: файлы вне плана, Анти-обход тест-гейта, Ревью независимым агентом — их способность ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит"]},"stopped":"blocked"}


Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.
