# Model diagnostics: ollama:qwen3-8b-ctx32k-stepfill-compactfill

Generated: 2026-09-30T12:04:23.251Z
Preflight exit code: 0
Source: 7a5b7ba72e9783450fa5e62634462fa328f446eb021401c9915cef6b58a8163d
Config: e38f6aa356d8ffa9cfd95fe2042b55790d35bfa70e495ef4cc033ea948c851f1

| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |
|---|---|---|---:|---|---:|---|
| I01 | oversize / intent | available | 1/1 | 0 run findings; completed | t=33s, tokens=73712 | not assessed |
| I02 | contradiction / intent | available | 1/1 | 0 run findings; completed | t=29s, tokens=71293 | not assessed |
| E01 | rename-field / explore | available | 1/1 | 1 run findings; STAGE_FAILED | t=180s, tokens=145206 | not assessed |
| E02 | multi-file-cascade / explore | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated multi-file-cascade snapshot after intent | t=—, tokens=— | not assessed |
| A01 | two-right-answers / ask | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated two-right-answers snapshot after explore | t=—, tokens=— | not assessed |
| A02 | impossible-without-data / ask | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated impossible-without-data snapshot after explore | t=—, tokens=— | not assessed |
| P01 | config-default / plan | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated config-default snapshot after ask | t=—, tokens=— | not assessed |
| P02 | migration-compat / plan | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated migration-compat snapshot after ask | t=—, tokens=— | not assessed |
| C01 | vat-rounding / chunk | available | 1/1 | 0 run findings; completed | t=148s, tokens=108848 | not assessed |
| C02 | rename-field / chunk | available | 1/1 | 0 run findings; completed | t=163s, tokens=82384 | not assessed |
| V00 | oversize / verify | available | 1/1 | 0/1 caught; STAGE_FAILED, SEED_MISSED | t=159s, tokens=559363 | not assessed |
| V01 | oversize / verify | available | 1/1 | 0/1 caught; STAGE_FAILED, SEED_MISSED | t=141s, tokens=554408 | not assessed |
| V02 | oversize / verify | available | 1/1 | 0/1 caught; STAGE_FAILED, SEED_MISSED | t=157s, tokens=596741 | not assessed |
| H01 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: oversize-verify-success: Error: ENOENT: no such file or directory, open 'D:\Проекты\Agent-SDLC-Runner\bench\snapshots\oversize-verify-success\snapshot.json' | t=—, tokens=— | not assessed |
| H02 | oversize / handoff | missing-snapshot | 0/1 | 0 run findings; missing-snapshot: no validated oversize snapshot after verify | t=—, tokens=— | not assessed |

## Known problem coverage

| Problem | Cases | Available inputs | Status |
|---:|---|---:|---|
| 1 | C01, C02 | 2/2 | inputs available |
| 2 | C01, C02 | 2/2 | inputs available |
| 3 | C01, C02 | 2/2 | inputs available |
| 4 | E01, E02 | 1/2 | partial or unavailable inputs |
| 5 | I01 | 1/1 | inputs available |
| 6 | P01, P02 | 0/2 | partial or unavailable inputs |
| 7 | I01, I02, C01 | 3/3 | inputs available |
| 8 | C01, C02 | 2/2 | inputs available |
| 9 | A01, A02 | 0/2 | partial or unavailable inputs |
| 10 | E01 | 1/1 | inputs available |
| 11 | C01, C02 | 2/2 | inputs available |
| 12 | C01, C02 | 2/2 | inputs available |
| 13 | C01, C02 | 2/2 | inputs available |
| 14 | I01 | 1/1 | inputs available |
| 15 | P01 | 0/1 | partial or unavailable inputs |
| 16 | — | 0/0 | outside model diagnosis |
| 17 | — | 0/0 | outside model diagnosis |
| 18 | — | 0/0 | outside model diagnosis |
| 19 | — | 0/0 | outside model diagnosis |
| 20 | — | 0/0 | outside model diagnosis |
| 21 | V00, V01, V02 | 3/3 | inputs available |
| 22 | V00, V01, V02 | 3/3 | inputs available |
| 23 | — | 0/0 | outside model diagnosis |
| 24 | — | 0/0 | outside model diagnosis |
| 25 | V00, V01, V02 | 3/3 | inputs available |
| 26 | C01 | 1/1 | inputs available |

## Suggestions

- Подготовить и проверить отсутствующие снимки, чтобы расширить покрытие известных проблем.
- Разобрать отчёты провалившихся кейсов; менять один параметр за сравнительный запуск.
- Для verify проверить обзор diff, передачу посева и инструкции reviewer; сверить находку с чистым контролем V00.
- Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.

Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.
