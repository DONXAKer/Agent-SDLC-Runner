export const protocolVersion = 1;

export function pageAfter(items, cursor, limit) {
  // Validate limit
  if (typeof limit !== 'number' || limit < 1 || limit > 100 || !Number.isInteger(limit)) {
    throw new RangeError('limit must be integer 1..100');
  }

  // Validate cursor
  if (cursor !== null && cursor !== undefined) {
    // Find the cursor in items
    const cursorIndex = items.findIndex(item => item.id === cursor);
    if (cursorIndex === -1) {
      throw new RangeError('unknown cursor');
    }
    // Start from the next item after cursor
    const startIndex = cursorIndex + 1;
    // Get the page
    const page = items.slice(startIndex, startIndex + limit);
    // Determine next cursor
    const nextCursor = page.length === limit && items.length > startIndex + limit ? items[startIndex + limit - 1].id : null;
    return { items: page, nextCursor };
  }

  // cursor is null or undefined - start from beginning
  const page = items.slice(0, limit);
  const nextCursor = page.length === limit && items.length > limit ? items[limit - 1].id : null;
  return { items: page, nextCursor };
}
