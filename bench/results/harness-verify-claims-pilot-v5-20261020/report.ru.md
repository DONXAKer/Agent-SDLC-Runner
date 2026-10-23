# Парное сравнение обвязки

Статус: environment-failure.

Гипотеза: Явный контракт статусов Verify и обратная связь для недопустимого manual помогают завершать приёмку без ослабления проверок.

Изменение: [точный diff](change.diff), server/src/run/guidedVerificationProtocol.ts.

Модель: ollama:comparison-qwen-off-q8; параметры: {"reasoning_effort":"none","max_tokens":4096,"temperature":0.15}. Лимиты: {"attempts":3,"stageMinutes":15,"runMinutes":30}.

| Вариант | Задача | Запуск / результат | Полный успех | Сбой этапа | Отказы claims | Токены вход / выход | Секунды |
|---|---|---|---|---|---|---|---|
| A | add-validator | complete / preflight-failed | false | неизвестно | неизвестно | неизвестно / неизвестно | 2 |
| B | add-validator | complete / preflight-failed | false | неизвестно | неизвестно | неизвестно / неизвестно | 1 |
| B | config-default | complete / preflight-failed | false | неизвестно | неизвестно | неизвестно / неизвестно | 1 |
| A | config-default | complete / preflight-failed | false | неизвестно | неизвестно | неизвестно / неизвестно | 2 |

Не все варианты дошли до Verify: для этих пар гипотеза остаётся непроверенной.

Статус урока: candidate.

- 1-A: [артефакты](runs/1-A/), причина: конфиг: контрольный маршрут: ENOENT: no such file or directory, open 'D:\Проекты\Agent-SDLC-Runner\bench\results\harness-verify-claims-pilot-v5-20261020\snapshots\A\bench\control.json'
- 1-B: [артефакты](runs/1-B/), причина: конфиг: контрольный маршрут: ENOENT: no such file or directory, open 'D:\Проекты\Agent-SDLC-Runner\bench\results\harness-verify-claims-pilot-v5-20261020\snapshots\B\bench\control.json'
- 2-B: [артефакты](runs/2-B/), причина: конфиг: контрольный маршрут: ENOENT: no such file or directory, open 'D:\Проекты\Agent-SDLC-Runner\bench\results\harness-verify-claims-pilot-v5-20261020\snapshots\B\bench\control.json'
- 2-A: [артефакты](runs/2-A/), причина: конфиг: контрольный маршрут: ENOENT: no such file or directory, open 'D:\Проекты\Agent-SDLC-Runner\bench\results\harness-verify-claims-pilot-v5-20261020\snapshots\A\bench\control.json'

Ограничения: по одному запуску варианта на задачу; нет оценки статистической устойчивости. Seed benchmark не является seed генерации модели. Независимые проверки обязательны; более длинная траектория не доказывает успех. Неизвестные метрики не считаются нулём. Урок не применяется автоматически.

Ошибка среды/исполнения: Error: Experiment settings, coordinator or Node version changed
