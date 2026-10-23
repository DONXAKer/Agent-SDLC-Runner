# Полный guided-цикл с независимой приёмкой

Статус: **complete**. Завершено: 25/25. Успех: 0.

| Модель | Задача | Статус | Успех | Причина |
|---|---|---|---|---|
| ollama:comparison-qwen-off-q8 | add-validator | complete | false | guided: Три предложения подряд не изменяют код; требуется пересмотреть гипотезу; применено 0 |
| ollama:comparison-qwen-off-q8 | config-default | complete | false | guided: Повтор чтения без новой информации: src/config.ts:1-22; источник уже показан при текущем хеше. Требуется решение по источнику или другой диапазон.; применено 0 |
| ollama:comparison-qwen-off-q8 | rename-field | complete | false | guided: Повтор чтения без новой информации: src/store.ts:1-60; источник уже показан при текущем хеше. Требуется решение по источнику или другой диапазон.; применено 0 |
| ollama:comparison-qwen-off-q8 | idempotent-retry | complete | false | Техническая остановка разрешения вопросов: 7d2ae5b03024aeba: context: Не удалось добрать исходник в пределах бюджета: src/index.ts экспортирует events, logEvent, resetLog из './log.ts', но файл не показан; нужно проверить, нет ли уже существующего типа ошибки или утилиты для бросания исключений, чтобы не дублировать.; d17c5bd71a0cd66a: context: Не удалось добрать исходник в пределах бюджета: Повтор чтения без новой информации: src/outbox.ts:26-33; источник уже показан при текущем хеше. Требуется решение по источнику или другой диапазон. |
| ollama:comparison-qwen-off-q8 | vat-rounding | complete | false | Техническая остановка разрешения вопросов: a8bcb9306f4a8feb: protocol: Не удалось разрешить кандидат в пределах бюджета: Error: Исходник src/vat.ts отсутствует или пуст; не повторяй чтение отсутствующего будущего модуля. Используй исходный запрос и существующие контракты; внутреннее решение оформи как engineering для проверки в плане, недостающее существенное правило — как human.; a12df86eca6f816d: context: Не удалось добрать исходник в пределах бюджета: Повтор чтения без новой информации: src/invoice.ts:1-39; источник уже показан при текущем хеше. Требуется решение по источнику или другой диапазон.; 6966f865ee7d21d5: protocol: Не удалось разрешить кандидат в пределах бюджета: Error: Исходник src/vat.ts отсутствует или пуст; не повторяй чтение отсутствующего будущего модуля. Используй исходный запрос и существующие контракты; внутреннее решение оформи как engineering для проверки в плане, недостающее существенное правило — как human. |
| ollama:mellum2-12b-instruct-q6 | add-validator | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| ollama:mellum2-12b-instruct-q6 | config-default | complete | false | Ремонт контракта не изменил адресованные секции |
| ollama:mellum2-12b-instruct-q6 | rename-field | complete | false | Контракт Intent противоречив после трёх ремонтов: Конструктор `product()` в `src/product.ts` получает поле `sku`, но при этом использует старое именно `code` для сборки объекта, что противоречит принципу совместимости, где должно использоваться новое имя `sku`.; Функция `parse()` в `src/store.ts` принимает строки с обоими именами `code` и `sku`, но если оба присутствуют, должно использоваться `sku`, а `code` — игнорироваться. Однако в реализации может быть ошибка, если `code` используется при сборке объекта, что нарушает согласованность с целью совместимости.; Функция `serialize()` в `src/store.ts` пишет только строку с полем `sku`, убирая ключ `code` полностью. Однако в сценарии сказано, что `code` должен быть учтён при чтении старых файлов, а `sku` — при записи новых. Если `serialize` убирает `code` совсем, то внешние службы, которые по-прежнему ожидают `code`, не смогут прочитать данные, что нарушает совместимость. |
| ollama:mellum2-12b-instruct-q6 | idempotent-retry | complete | false | Ремонт контракта не изменил адресованные секции |
| ollama:mellum2-12b-instruct-q6 | vat-rounding | complete | false | Контракт Intent противоречив после трёх ремонтов: Контракт задаёт прямое добавление НДС к счётам без налога (Что делаем, Л1-Л2), но исходный запрос запрещает что-либо добавлять к таким счётам (Чего не делаем, Л1-Л2).; Контракт требует реализации правила расчёта налога в отдельном модуле src/vat.ts (Что делаем, Л16-L17), но исходный запрос утверждает, что правило не должно лежать там (Чего не делаем, Л16-L17).; Контракт требует, чтобы функция bill принимала параметр opts.vat: 'std' \| 'none' (Что делаем, Л8-L10), но исходный запрос не упоминает такой параметр и не указывает, что он должен быть добавлен (Приёмочный лист, Л1-Л3).; Контракт требует, чтобы для необлагаемых счётов поле vat не добавлялось, а объект оставался в той же форме { number, customer, lines, subtotal, total } (Что делаем, Л13-L14), но исходный запрос утверждает, что для необлагаемых счётов должно быть добавлено поле vat: 0 (Чего не делаем, Л13-L14).; Контракт требует, чтобы существующие тесты остались без правок (Чего не делаем, Л4), но исходный запрос не упоминает тесты и не устанавливает, что они должны остаться без изменений (Приёмочный лист, Л4-Л5). |
| ollama:gpt-oss-20b-ctx32k | add-validator | complete | false | Контракт Intent противоречив после трёх ремонтов: Исходный запрос требует реэкспорт через src/index.ts, но «Чего не делаем» запрещает его. Сохрани требуемый реэкспорт как исключение из общей границы; остальные запреты сохраняются. |
| ollama:gpt-oss-20b-ctx32k | config-default | complete | false | План не подготовлен: Не все требования покрыты шагами: claim-4. Свяжи их с реализацией, экспортом или тестами по смыслу приёмочного листа. |
| ollama:gpt-oss-20b-ctx32k | rename-field | complete | false | План не подготовлен: карта плана разошлась с кодовой базой; вернись на этап 4 до расхода попытки: - шаг 3: test/store.test.ts отсутствует в files_to_touch - карта вызывающих не доведена: для каждого найденного места вызова укажи контракт и решение по колонке «Учтены в files_to_touch?»: src/product.ts:product ← test/store.test.ts:15; src/store.ts:serialize ← test/store.test.ts:20 |
| ollama:gpt-oss-20b-ctx32k | idempotent-retry | complete | false | План не подготовлен: шаг 3: symbol — Too small: expected string to have >=1 characters шаг 3: action — Too small: expected string to have >=1 characters шаг 3: check — Too small: expected string to have >=1 characters шаг 3: expected — Too small: expected string to have >=1 characters шаг 3: contract — Too small: expected string to have >=1 characters |
| ollama:gpt-oss-20b-ctx32k | vat-rounding | complete | false | stage-deadline: этап plan превысил лимит стенных часов (900000 мс) |
| ollama:granite4.2-8b-ctx32k | add-validator | complete | false | stage-deadline: этап intent превысил лимит стенных часов (900000 мс) |
| ollama:granite4.2-8b-ctx32k | config-default | complete | false | stage-deadline: этап intent превысил лимит стенных часов (900000 мс) |
| ollama:granite4.2-8b-ctx32k | rename-field | complete | false | stage-deadline: этап intent превысил лимит стенных часов (900000 мс) |
| ollama:granite4.2-8b-ctx32k | idempotent-retry | complete | false | Нет адресованного ремонта src/sender.ts: Исправь ответ для текущего файла: Нужен завершённый JSON без инструментальных вызовов. fact/impact — по 1–3 предложения. |
| ollama:granite4.2-8b-ctx32k | vat-rounding | complete | false | stage-deadline: этап intent превысил лимит стенных часов (900000 мс) |
| ollama:comparison-neohorse | add-validator | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| ollama:comparison-neohorse | config-default | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| ollama:comparison-neohorse | rename-field | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| ollama:comparison-neohorse | idempotent-retry | complete | false | guided: Повторено отклонённое предложение при неизменных файлах: Предложенная группа НЕ применена. Состояние файлов на диске не изменено этой группой; диагностический snippet может описывать промежуточную симуляцию, а не диск. Для ремонта используй актуальный workingContext или Read. Синтаксис черновика src\sender.ts: Return statement is not allowed here. Файл не записан; исправь операцию.; применено 0 |
| ollama:comparison-neohorse | vat-rounding | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |

Приёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.

Ошибка: Error: GPU wait budget exhausted; remaining cases not run

## Профили

- ollama:comparison-qwen-off-q8: gpu-only, context=32768
- ollama:mellum2-12b-instruct-q6: gpu-only, context=32768
- ollama:gpt-oss-20b-ctx32k: gpu-only, context=32768
- ollama:granite4.2-8b-ctx32k: gpu-only, context=32768
- ollama:comparison-neohorse: gpu-only, context=32768

Время hybrid нельзя напрямую сравнивать с gpu-only.

## Квалификация протокола

- ollama:comparison-qwen-off-q8: PASS, 8/8; 
- ollama:mellum2-12b-instruct-q6: PASS, 8/8; 
- ollama:gpt-oss-20b-ctx32k: PASS, 8/8; 
- ollama:granite4.2-8b-ctx32k: PASS, 8/8; 
- ollama:comparison-neohorse: PASS, 8/8; 
