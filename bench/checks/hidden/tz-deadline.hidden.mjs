/**
 * Скрытые тесты задачи tz-deadline — обёртка над общим раннером семейства booking.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test tz-deadline.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'tz-deadline';
await import('./lib/booking-runner.mjs');
