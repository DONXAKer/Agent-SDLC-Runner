/**
 * Скрытые тесты задачи holdout-winter-surcharge — обёртка над общим раннером семейства fleet.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test holdout-winter-surcharge.hidden.mjs`; без
 * переменной цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'holdout-winter-surcharge';
await import('./lib/fleet-runner.mjs');
