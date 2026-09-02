/**
 * Скрытые тесты задачи docs-sync — обёртка над общим раннером семейства legacy-docs.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test docs-sync.hidden.mjs`; без переменной цель —
 * пристинная фикстура (regression зелёные, precision красные — так задумано; R3 — файловый
 * сторож неизменности кода aggregate.ts, зелёный на пристинной по дизайну).
 */

process.env.BENCH_EXPECTED_SLUG = 'docs-sync';
await import('./lib/legacy-docs-runner.mjs');
