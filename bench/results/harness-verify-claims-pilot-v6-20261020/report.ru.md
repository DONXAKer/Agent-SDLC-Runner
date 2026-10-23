# Парное сравнение обвязки

Статус: complete.

Гипотеза: Явный контракт статусов Verify и обратная связь для недопустимого manual помогают завершать приёмку без ослабления проверок.

Изменение: [точный diff](change.diff), server/src/run/guidedVerificationProtocol.ts.

Модель: ollama:comparison-qwen-off-q8; параметры: {"reasoning_effort":"none","max_tokens":4096,"temperature":0.15}. Лимиты: {"attempts":3,"stageMinutes":15,"runMinutes":30}.

| Вариант | Задача | Запуск / результат | Полный успех | Сбой этапа | Отказы claims | Токены вход / выход | Секунды |
|---|---|---|---|---|---|---|---|
| A | add-validator | complete / failed | false | verify | неизвестно | 179836 / 10707 | 857 |
| B | add-validator | complete / failed | false | verify | неизвестно | 197296 / 11344 | 903 |
| B | config-default | complete / failed | false | plan | неизвестно | 58708 / 9391 | 616 |
| A | config-default | complete / failed | false | ask | неизвестно | 40462 / 3237 | 229 |

Не все варианты дошли до Verify: для этих пар гипотеза остаётся непроверенной.

Статус урока: candidate.

- 1-A: [артефакты](runs/1-A/), причина: этап закончился, но артефакт не заполнен: C:\Users\Root\AppData\Local\Temp\sdlc-bench-5Z2eie\.sdlc\harness-5ffce08a-1c20-44f6-a5af-53e4dc421154\verification-report-1-attempt-1.md (1 незаполненных полей)
- 1-B: [артефакты](runs/1-B/), причина: этап закончился, но артефакт не заполнен: C:\Users\Root\AppData\Local\Temp\sdlc-bench-2amrSf\.sdlc\harness-41578d11-144e-4c23-99d2-b0cbb0061086\verification-report-1-attempt-1.md (1 незаполненных полей)
- 2-B: [артефакты](runs/2-B/), причина: План не подготовлен: в «Подход» укажи файлы и символы, по которым выбрано решение
- 2-A: [артефакты](runs/2-A/), причина: Не получен ответ на 1 блокирующих вопросов

Ограничения: по одному запуску варианта на задачу; нет оценки статистической устойчивости. Seed benchmark не является seed генерации модели. Независимые проверки обязательны; более длинная траектория не доказывает успех. Неизвестные метрики не считаются нулём. Урок не применяется автоматически.
