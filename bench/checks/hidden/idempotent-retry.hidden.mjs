/**
 * Скрытые тесты задачи idempotent-retry — обёртка над общим раннером семейства notify.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test idempotent-retry.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'idempotent-retry';
await import('./lib/notify-runner.mjs');
