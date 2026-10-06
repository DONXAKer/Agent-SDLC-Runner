/**
 * Скрытые тесты задачи holdout-trailer-rule — обёртка над общим раннером семейства fleet.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test holdout-trailer-rule.hidden.mjs`; без
 * переменной цель — пристинная фикстура (regression зелёные, human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'holdout-trailer-rule';
await import('./lib/fleet-runner.mjs');
