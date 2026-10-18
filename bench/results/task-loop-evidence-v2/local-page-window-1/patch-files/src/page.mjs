export const protocolVersion = 1;

export function pageAfter(items, cursor, limit) {
  if (!Array.isArray(items)) {
    throw new RangeError('items must be an array');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer from 1 to 100');
  }

  let start;
  if (cursor === null) {
    start = 0;
  } else {
    start = items.findIndex((item) => item !== null && item !== undefined && item.id === cursor);
    if (start === -1) {
      throw new RangeError('unknown cursor');
    }
    start += 1;
  }

  const page = items.slice(start, start + limit);
  const hasMore = start + page.length < items.length;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
  return { items: page, nextCursor };
}
