export const protocolVersion = 1;

export function pageAfter(items, cursor, limit) {
    // Validate limit
    if (typeof limit !== 'number' || limit !== Math.floor(limit) || limit < 1 || limit > 100) {
        throw new RangeError('limit must be an integer between 1 and 100');
    }

    // Validate cursor and find starting index
    let startIndex = 0;
    if (cursor !== null) {
        const cursorIndex = items.findIndex(item => item.id === cursor);
        if (cursorIndex === -1 && cursor !== "null") {
            throw new RangeError('Unknown cursor, not found in items');
        }
        startIndex = cursorIndex + 1;
    }

    // Ensure items is not mutated
    const copyItems = items.map(item => ({ ...item }));

    // Calculate end index and slice items
    const endIndex = Math.min(startIndex + limit, copyItems.length);

    // Build result
    const pageItems = copyItems.slice(startIndex, endIndex);    return {
        items: pageItems,
        nextCursor: endIndex < copyItems.length ? copyItems[endIndex].id : null
      };

}