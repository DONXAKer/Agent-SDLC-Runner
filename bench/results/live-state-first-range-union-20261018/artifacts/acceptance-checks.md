# Независимые приёмочные проверки

- Ревизия: f239115f-9b96-4cf7-beed-1e90f0c72f27
- Проверяющий: model:openai:codex-assistant-session
- Зафиксировал: Codex — запуск по поручению пользователя · 2026-10-18T16:09:29.396Z
- Контракт (SHA-256): bd3b7a0509ba22389df83bc53ae140089c49a0f94b64ffc30a6dfb56b045db40
- План (SHA-256): 9d94c5ea006f3f5b4cf23e6429fb1a96ae51f4903a6411ae8e448c803d63f392
- Образ: sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
- Ограничения: Node built-in modules, finite input classes; no proof of arbitrary numeric behavior

| Claim | Тест | Имя проверки |
|---|---|---|
| claim-1 | contract.test.mjs | sorted merged ranges |
| claim-2 | contract.test.mjs | input and output independence |
| claim-3 | contract.test.mjs | invalid values throw TypeError |
| claim-4 | contract.test.mjs | preserve API and add tests |

Набор хранится вне проекта. Результаты сохраняются отдельно.
