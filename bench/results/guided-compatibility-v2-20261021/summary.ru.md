# Полный guided-цикл с независимой приёмкой

Статус: **stopped**. Завершено: 0/30. Успех: 0.

| Модель | Задача | Статус | Успех | Причина |
|---|---|---|---|---|
| ollama:comparison-qwen-off-q8 | add-validator | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | config-default | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | rename-field | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | vat-rounding | pending | неизвестно | неизвестно |
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
| ollama:ministral3-14b-instruct-ctx32k | add-validator | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | config-default | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | rename-field | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | vat-rounding | pending | неизвестно | неизвестно |
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

Ошибка: Error: Qualification failed: full matrix withheld; inspect qualifications

## Профили

- ollama:comparison-qwen-off-q8: gpu-only, context=32768
- ollama:mellum2-12b-instruct-q6: gpu-only, context=32768
- ollama:gpt-oss-20b-ctx32k: gpu-only, context=32768
- ollama:ministral3-14b-instruct-ctx32k: gpu-only, context=32768
- ollama:devstral-small-2: hybrid, context=16384
- ollama:comparison-neohorse: gpu-only, context=32768

Время hybrid нельзя напрямую сравнивать с gpu-only.

## Квалификация протокола

- ollama:comparison-qwen-off-q8: FAIL, 0/1; Error: /api/generate: 500
- ollama:mellum2-12b-instruct-q6: PASS, 8/8; 
- ollama:gpt-oss-20b-ctx32k: PASS, 8/8; 
- ollama:ministral3-14b-instruct-ctx32k: FAIL, 7/8; Error: protocol or semantics mismatch
- ollama:devstral-small-2: PASS, 8/8; 
- ollama:comparison-neohorse: PASS, 8/8; 

## Итог после отдельных повторов

Квалифицированы **5 из 6 профилей**. Qwen повторно прошёл 8/8 после ошибки CUDA при
первоначальной загрузке. Проверены совпадение digest модели, параметров и хешей
исходников рантайма со снимком. Первоначальный отказ сохранён в manifest.json.
Подробности: [followup-summary.json](followup-summary.json),
[повтор Qwen](../qwen-profile-retry-20261021.json).

Ministral в основном проходе получил 7/8, при temperature=0 — 6/8: в обеих сериях
повтора назвал связанное объявление Parcel функцией вместо интерфейса. Ожидаемые
ответы и валидаторы не менялись. Профиль temperature=0 не принят как улучшение.
[Ответы повторной проверки](../ministral-temperature0-20261021.json).

Матрица 6×5 **не запускалась**: условие квалификации всех шести профилей не выполнено.
Ни один из этих протокольных тестов не доказывает прохождение полного SDLC.

## Реализованные изменения и проверки

- Из ревью контракта удалён пример, переносивший чужую предметную область в замечания.
- Ask и Chunk учитывают показанные строки, хеши и повторные чтения; изменённый оператором
  адрес сначала проходит проверку прав. Новые диапазоны и изменённые источники доступны.
- После обрезки большого Plan запрашивается каркас и отдельные карточки; обычный
  адресный ремонт ограничен одной карточкой. Сохраняются проверки связности и AST.
- Цель символа определяется текущим исходником: путь, регистр, вид объявления,
  диапазон и хеш. Ограничения enum дополнительно показываются в промпте провайдера.
- no_change сохраняется по файлам и рассматривается рецензентом с точными цитатами
  исходника и требования. Только проверенное решение с актуальным хешем учитывает Scope.
- Дедлайн отличается от отмены оператором; после таймаута Intent v4 продолжение
  запрещено. Добавлены отдельные признаки остановки и исключение таймаута запроса.
- Неподдерживаемый thinking-параметр больше не удаляется при скрытом повторе.
- Devstral допускает hybrid; остальные профили сохраняют gpu-only. Контекст и q8 KV
  проверяются фактически. Параметры и результаты квалификации сохранены.

Проверки: сервер — 2907 PASS, 10 SKIP; обвязка — 401 PASS, 7 SKIP; сквозной Docker
симулятор — 10 PASS. Ошибок нет. Проверки типов server и bench и git diff --check пройдены.
[Машиночитаемый журнал проверок](checks.json).

Ограничения: описание символов использует существующий облегчённый сканер
TypeScript/JavaScript, универсальная поддержка языков не заявляется. Проверка цитат
подтверждает происхождение текста, но его смысл оценивает рецензент. Подсказка схемы
ограничена по размеру и не заменяет строгую валидацию. Два повтора коротких проверок
подтверждают базовую совместимость протокола, а не устойчивость на произвольных задачах.
