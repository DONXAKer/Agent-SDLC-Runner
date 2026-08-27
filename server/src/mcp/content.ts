/**
 * Свёртка ответа MCP-инструмента в текст для модели.
 *
 * Главное здесь — картинки. Скриншот PIE приезжает в `content` как base64 на сотни
 * килобайт: это десятки тысяч токенов, то есть мгновенная смерть локального контура на
 * 16K и крупный счёт на подписке. Поэтому изображение уходит файлом рядом с артефактами
 * витка, а модели достаётся строка с путём и размером. Локальные модели почти все и не
 * мультимодальны — им base64 не дал бы ничего, кроме съеденного контекста.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface TextBlock {
  type: 'text';
  text: string;
}
interface ImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}
interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}
interface ResourceBlock {
  type: 'resource';
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}

type Block = TextBlock | ImageBlock | ResourceLinkBlock | ResourceBlock | { type: string };

export interface FoldOptions {
  /**
   * Куда класть изображения. Возвращает путь для показа модели.
   * Не задано — изображение описывается размером, но не сохраняется.
   */
  saveImage?: (data: Buffer, mimeType: string) => string;
}

function extFor(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'bin';
}

/** Сохранение изображения по шаблону пути `<...>.<ext>`; каталог создаётся при нужде. */
export function imageSaver(pathWithoutExt: () => string): (d: Buffer, m: string) => string {
  return (data, mimeType) => {
    const file = `${pathWithoutExt()}.${extFor(mimeType)}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };
}

export function foldContent(
  result: { content?: unknown; isError?: unknown },
  opts: FoldOptions = {},
): { ok: boolean; text: string } {
  const blocks: Block[] = Array.isArray(result.content) ? (result.content as Block[]) : [];
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push((block as TextBlock).text);
        break;

      case 'image': {
        const b = block as ImageBlock;
        const data = Buffer.from(b.data, 'base64');
        const size = `${Math.round(data.byteLength / 1024)} КБ`;
        if (opts.saveImage === undefined) {
          parts.push(`[изображение ${b.mimeType}, ${size} — не сохранено]`);
          break;
        }
        const file = opts.saveImage(data, b.mimeType);
        parts.push(`[изображение сохранено: ${file} (${b.mimeType}, ${size})]`);
        break;
      }

      case 'resource_link': {
        const b = block as ResourceLinkBlock;
        parts.push(`[ресурс: ${b.uri}${b.mimeType === undefined ? '' : ` (${b.mimeType})`}]`);
        break;
      }

      case 'resource': {
        const r = (block as ResourceBlock).resource;
        if (typeof r?.text === 'string') {
          parts.push(`[${r.uri}]\n${r.text}`);
        } else {
          parts.push(`[ресурс ${r?.uri ?? 'без uri'} — не текстовый, не показан]`);
        }
        break;
      }

      default:
        parts.push(`[блок «${block.type}» рантайм показывать не умеет]`);
    }
  }

  const text = parts.join('\n').trim();
  return {
    ok: result.isError !== true && !envelopeFailed(text),
    text: text === '' ? 'сервер вернул пустой ответ' : text,
  };
}

/**
 * Провал, объявленный внутри текста ответа, а не флагом `isError`.
 *
 * Наблюдение с живого сервера WarCard: при выключенном редакторе `pie_status` возвращает
 * конверт с `"ok": false` и текстом «No Unreal connection», но `isError` не ставит — и
 * неудачный вызов приезжал бы в ленту витка успехом. Модель причину прочитает (текст
 * отдаётся как есть), а вот рантайм записал бы тихий успех, от которого этот сервис
 * защищается везде.
 *
 * Правило нарочно узкое: весь ответ целиком — объект JSON, и булево поле `ok` или
 * `success` ВЕРХНЕГО уровня равно `false`. Ни поиска подстрок, ни разбора вложенного:
 * там `ok` — это уже данные инструмента («ассета нет»), а не статус вызова, и трактовать
 * их формы мы права не имеем.
 */
function envelopeFailed(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;

  const env = parsed as { ok?: unknown; success?: unknown };
  return env.ok === false || env.success === false;
}
