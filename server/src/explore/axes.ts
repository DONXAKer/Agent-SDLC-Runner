/**
 * Кандидаты механизмов проекта по осям прод-готовности — для секции «Опоры осей» отчёта
 * разведки. Словарь признаков, а не понимание: он лишь называет модели МЕСТА, где в коде
 * видно что-то похожее на валидацию, кэш, обработку отказа, чтение настроек, схему данных
 * или логирование. «Нет механизма» — законный ответ, и пустой список кандидатов ему не
 * противоречит.
 *
 * Ключи типизированы `AxisName`, как `AXIS_HINTS` в `reviewFill.ts`: седьмая ось в каноне
 * даст ошибку типов здесь, а не молчаливо пустой словарь.
 */

import { AXES, type AxisName } from '../artifacts/planAxes.ts';
import { enclosingSymbol } from './symbols.ts';
import type { ExploreIndex } from './types.ts';

export const AXIS_MECHANISM_PATTERNS: Readonly<Record<AxisName, readonly RegExp[]>> = {
  'Безопасность': [/validat|sanitiz|escape|auth|permission|secret|token|assert\(|throw new (?:Type|Range)Error/i],
  'Ресурсы и скорость': [/cache|timeout|limit|batch|pool|throttl|memo|debounce|Math\.min\(/i],
  'Отказы зависимостей': [/try\s*\{|catch\s*[({]|retry|fallback|fetch\(|readFile|\.catch\(/i],
  'Настройки': [/process\.env|config|options|flag|DEFAULT_|default:/i],
  'Совместимость и данные': [/migrat|schema|version|serializ|JSON\.parse|export (?:interface|type)/i],
  'Наблюдаемость': [/console\.|logger|log\(|metric|trace|emit\(/i],
};

export interface MechanismHit {
  path: string;
  symbol: string | null;
  line: number;
  snippet: string;
}

/** До `max` мест на ось, по одному на файл, в порядке индекса. Тесты и документы не смотрятся. */
export function axisMechanismCandidates(index: ExploreIndex, max = 3): Record<AxisName, MechanismHit[]> {
  const out = Object.fromEntries(AXES.map((a) => [a, [] as MechanismHit[]])) as Record<AxisName, MechanismHit[]>;
  for (const axis of AXES) {
    const patterns = AXIS_MECHANISM_PATTERNS[axis];
    for (const f of index.files) {
      if (f.kind !== 'code') continue;
      if (out[axis].length >= max) break;
      const lines = f.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.trim().startsWith('//') || l.trim().startsWith('*')) continue; // комментарии не механизм
        if (!patterns.some((re) => re.test(l))) continue;
        out[axis].push({ path: f.path, symbol: enclosingSymbol(f, i + 1), line: i + 1, snippet: l.trim().slice(0, 120) });
        break;
      }
    }
  }
  return out;
}
