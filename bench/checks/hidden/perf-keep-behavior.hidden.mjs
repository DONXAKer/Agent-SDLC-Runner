/**
 * Скрытые тесты задачи perf-keep-behavior — обёртка над общим раннером семейства ledger.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test perf-keep-behavior.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'perf-keep-behavior';
await import('./lib/ledger-runner.mjs');
