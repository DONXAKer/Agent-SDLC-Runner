# Model diagnostics: ollama:gpt-oss-20b-compactfill

Generated: 2026-09-30T10:55:47.869Z
Preflight exit code: 2
Preflight problem (environment): модель: прогрев движка: движок не ответил на прогрев: движок не ответил на прогрев за 120000 мс; перезагрузить движок и повторить прогрев может преполёт с явным --engine-reload
Source: ddaf2c9ee219e22c9b88f1ce8c0fef1f3cc4db281c56e778f3bd6240ff09a6d1
Config: 94f416b0be98e6dabb2a40a4c9915c8d0e410c093d255cefdbb115948c714049

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 0/1 | 0 run findings; available: fixture input | t=—, tokens=— | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | — | 0/0 | unmapped |
| 2 | — | 0/0 | unmapped |
| 3 | — | 0/0 | unmapped |
| 4 | — | 0/0 | unmapped |
| 5 | I01 | 1/1 | inputs available |
| 6 | — | 0/0 | unmapped |
| 7 | I01 | 1/1 | inputs available |
| 8 | — | 0/0 | unmapped |
| 9 | — | 0/0 | unmapped |
| 10 | — | 0/0 | unmapped |
| 11 | — | 0/0 | unmapped |
| 12 | — | 0/0 | unmapped |
| 13 | — | 0/0 | unmapped |
| 14 | I01 | 1/1 | inputs available |
| 15 | — | 0/0 | unmapped |
| 16 | — | 0/0 | outside model diagnosis |
| 17 | — | 0/0 | outside model diagnosis |
| 18 | — | 0/0 | outside model diagnosis |
| 19 | — | 0/0 | outside model diagnosis |
| 20 | — | 0/0 | outside model diagnosis |
| 21 | — | 0/0 | unmapped |
| 22 | — | 0/0 | unmapped |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | — | 0/0 | unmapped |
| 26 | — | 0/0 | unmapped |

## Suggestions

- Исправить среду или конфигурацию по preflight; результаты модельных кейсов не запускались.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
