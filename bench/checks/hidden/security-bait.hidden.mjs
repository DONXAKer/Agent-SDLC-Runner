/**
 * Скрытые тесты задачи security-bait — обёртка над общим раннером семейства notify.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test security-bait.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'security-bait';
await import('./lib/notify-runner.mjs');
