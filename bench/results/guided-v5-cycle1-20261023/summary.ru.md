# Полный guided-цикл с независимой приёмкой

Статус: **stopped**. Завершено: 5/30. Успех: 0.

| Модель | Задача | Статус | Успех | Причина |
|---|---|---|---|---|
| ollama:comparison-qwen-off-q8 | add-validator | complete | false | guided: Три предложения подряд не изменяют код; требуется пересмотреть гипотезу; применено 5 |
| ollama:comparison-qwen-off-q8 | config-default | complete | false | План не подготовлен: Не все требования покрыты шагами: claim-5. Свяжи их с реализацией, экспортом или тестами по смыслу приёмочного листа. |
| ollama:comparison-qwen-off-q8 | rename-field | complete | false | stage-deadline: этап plan превысил лимит стенных часов (900000 мс) |
| ollama:comparison-qwen-off-q8 | idempotent-retry | complete | false | План не подготовлен: Не все требования покрыты шагами: claim-5. Свяжи их с реализацией, экспортом или тестами по смыслу приёмочного листа. |
| ollama:comparison-qwen-off-q8 | vat-rounding | complete | false | stage-deadline: этап plan превысил лимит стенных часов (900000 мс) |
| ollama:mellum2-12b-instruct-q6 | add-validator | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | config-default | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | rename-field | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | vat-rounding | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | add-validator | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | config-default | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | rename-field | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | vat-rounding | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | add-validator | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | config-default | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | rename-field | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | vat-rounding | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | add-validator | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | config-default | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | rename-field | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | vat-rounding | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | add-validator | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | config-default | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | rename-field | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | vat-rounding | pending | неизвестно | неизвестно |

Приёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.

Ошибка: TimeoutError: The operation was aborted due to timeout

## Профили

- ollama:comparison-qwen-off-q8: gpu-only, context=32768
- ollama:mellum2-12b-instruct-q6: gpu-only, context=32768
- ollama:gpt-oss-20b-ctx32k: gpu-only, context=32768
- ollama:granite4.2-8b-ctx32k: gpu-only, context=32768
- ollama:devstral-small-2: hybrid, context=16384
- ollama:comparison-neohorse: gpu-only, context=32768

Время hybrid нельзя напрямую сравнивать с gpu-only.

## Квалификация протокола

- ollama:comparison-qwen-off-q8: PASS, 12/12; 
- ollama:mellum2-12b-instruct-q6: PASS, 12/12; 
- ollama:gpt-oss-20b-ctx32k: PASS, 12/12; 
- ollama:granite4.2-8b-ctx32k: PASS, 12/12; 
- ollama:devstral-small-2: PASS, 12/12; 
- ollama:comparison-neohorse: PASS, 12/12; 
