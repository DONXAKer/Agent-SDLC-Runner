/**
 * Скрытые тесты задачи rename-field — обёртка над общим раннером семейства catalog.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test rename-field.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'rename-field';
await import('./lib/catalog-runner.mjs');
