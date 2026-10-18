export const protocolVersion = 1;

export function pageAfter(items, cursor, limit) {
  // Validate limit
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer between 1 and 100');
  }

  // Find the starting index
  let startIndex = 0;
  if (cursor !== null) {
    const cursorIndex = items.findIndex(item => item.id === cursor);
    if (cursorIndex === -1) {
      throw new RangeError('unknown cursor');
    }
    startIndex = cursorIndex + 1;
  }

  // Extract the page
  const pageItems = items.slice(startIndex, startIndex + limit);
  const lastReturnedId = pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null;
  const nextCursor = (startIndex + pageItems.length < items.length) ? lastReturnedId : null;

  return {
    items: pageItems,
    nextCursor
  };
}
