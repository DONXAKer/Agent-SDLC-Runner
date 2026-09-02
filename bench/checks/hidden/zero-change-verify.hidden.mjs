/**
 * Скрытые тесты задачи zero-change-verify — обёртка над общим раннером семейства ledger.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test zero-change-verify.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'zero-change-verify';
await import('./lib/ledger-runner.mjs');
