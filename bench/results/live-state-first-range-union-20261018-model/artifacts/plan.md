# План: range union

- **Требования (SHA-256):** f9ae6698264f5a3eedafc8d2e8a6dcfa6dce4861564a75543dbb0cd80216c003
- **Одобрение:** Codex — запуск по поручению пользователя · 2026-10-18 — Контракт и план утверждены до реализации. Объём пилота: Chunk и Verify, подготовка v1 оператором.

## files_to_touch

| Путь | Что делаем |
|---|---|
| src/ranges.mjs | Add mergeRanges, preserve protocolVersion |
| test/merge-ranges.test.mjs | New executable tests; leave existing.test.mjs unchanged |

## Шаги

1. Read public module and existing test.
2. Implement the contract in the public module, add a new test.
3. Fill chunk journal using the methodology template. Runtime executes checks.
