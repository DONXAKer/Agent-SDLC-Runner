export const protocolVersion = 1;

export function pageAfter(items, cursor, limit) {
  if (!Array.isArray(items)) {
    throw new RangeError('items must be an array');
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer between 1 and 100');
  }

  let start;
  if (cursor === null || cursor === undefined) {
    start = 0;
  } else {
    const index = items.findIndex((item) => typeof item === 'object' && item !== null && item.id === cursor);
    if (index === -1) {
      throw new RangeError(`unknown cursor: ${cursor}`);
    }
    start = index + 1;
  }

  const page = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return {items: page, nextCursor};
}
