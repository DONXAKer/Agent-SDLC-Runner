/**
 * Регенерация улик попытки после посева на восстановленном снимке.
 *
 * Root-cause (`docs/model-runs.md`, серия 2026-09-27/28): рецензент и встроенные гейты
 * читают ПАТЧ С ДИСКА (`chunk-N-attempt-K-diff.patch`) — тот же путь, что и на живом
 * витке (`server/src/run/stages/verify/reviewer.ts`, `verify/records.ts`, `verify/ensemble.ts`,
 * `gates/builtin/attemptPatch.ts`). Посев (`bench/src/seeds.ts`) правит ФАЙЛ ФИКСТУРЫ в
 * рабочей копии, а патч снимка снят ДО посева — расхождение неизбежно, и рецензент,
 * читающий только патч, посеянного дефекта не видит вовсе. Докстринг `seeds.ts` («патч
 * рантайм перегенерирует сам») был неверен для старта с `--from-snapshot`: перегенерация
 * происходит только в конце chunk'а (`run/evidence.ts::recordAttemptEvidence`), а посев
 * вносится ПОСЛЕ восстановления снимка, когда chunk уже отработал в прошлом.
 *
 * Отсюда и два шумовых основания вердикта на посеянных прогонах: «перегенерированный diff
 * не совпал с патчем попытки» (`verify/gates.ts::diffStillMatchesTree`) и (независимо от
 * посева) «evidence.json нет» для снимков, снятых до появления файла улик (2026-09-25,
 * `e88f157`) — на них чинит только пересъёмка снимка.
 *
 * Этот модуль воспроизводит РОВНО ту часть `recordAttemptEvidence`, которая касается
 * патча: перегенерирует его из ФАКТИЧЕСКОГО дерева (с уже применённым посевом) и
 * обновляет `diff_sha256`/`diff_empty`/`diffstat` в `evidence.json` последней попытки.
 * Вывод тестов не трогается — тесты фикстуры посев `expected: 'review'` не видят по
 * определению (иначе это был бы `expected: 'gate'`), `tests_sha256` остаётся прежним.
 * Никаких меток посева в записи не появляется — рецензент обязан узнать о нём тем же
 * способом, что и на живом витке: прочитав diff.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { attemptDiff } from '../../server/src/gates/git.ts';
import { diffstat } from '../../server/src/diff/diffstat.ts';
import { sha256Text } from '../../server/src/run/evidence.ts';
import type { AttemptEvidence } from '../../server/src/run/evidence.ts';
import { WitokPaths } from '../../server/src/artifacts/paths.ts';

export class SeedEvidenceError extends Error {}

const EVIDENCE_RE = /^chunk-(\d+)-attempt-(\d+)-evidence\.json$/;

/** Находит (chunk, attempt) последней записи улик в каталоге витка. */
function latestAttempt(witokDir: string): { chunk: number; attempt: number } | null {
  if (!existsSync(witokDir)) return null;
  let best: { chunk: number; attempt: number } | null = null;
  for (const name of readdirSync(witokDir)) {
    const m = EVIDENCE_RE.exec(name);
    if (m === null) continue;
    const chunk = Number(m[1]);
    const attempt = Number(m[2]);
    if (best === null || chunk > best.chunk || (chunk === best.chunk && attempt > best.attempt)) {
      best = { chunk, attempt };
    }
  }
  return best;
}

/**
 * Перегенерирует патч и хэш в `evidence.json` последней попытки под ФАКТИЧЕСКОЕ дерево
 * `wsRoot` (после `applySeed`). Бросает `SeedEvidenceError` с понятной причиной вместо
 * молчаливого пропуска — «поймано 0 посевов» неотличимо от «стенд их и не показывал».
 */
export async function refreshAttemptEvidence(wsRoot: string, slug: string): Promise<void> {
  const paths = new WitokPaths(wsRoot, slug);
  const found = latestAttempt(paths.dir);
  if (found === null) {
    throw new SeedEvidenceError(
      `в ${paths.dir} нет ни одной chunk-N-attempt-K-evidence.json — снимок снят до появления ` +
        'файла улик (коммит e88f157, 2026-09-25); пересними снимок текущим рантаймом',
    );
  }
  const { chunk, attempt } = found;
  const evidencePath = paths.chunkEvidence(chunk, attempt);
  const diffPath = paths.chunkDiff(chunk, attempt);
  if (!existsSync(diffPath)) {
    throw new SeedEvidenceError(`${diffPath} не существует — патча попытки нет, перегенерировать нечего`);
  }

  let evidence: AttemptEvidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as AttemptEvidence;
  } catch (e) {
    throw new SeedEvidenceError(`${evidencePath} не читается как JSON: ${(e as Error).message}`);
  }

  const diff = await attemptDiff(wsRoot, { baseSha: evidence.base_sha });
  writeFileSync(diffPath, Buffer.from(diff, 'utf8'));

  const updated: AttemptEvidence = {
    ...evidence,
    diff_sha256: sha256Text(diff),
    diff_empty: diff.trim() === '',
    diffstat: diffstat(diff),
  };
  writeFileSync(evidencePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}
