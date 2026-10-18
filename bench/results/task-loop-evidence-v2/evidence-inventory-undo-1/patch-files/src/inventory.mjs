export const protocolVersion = 1;

let tokenCounter = 0;
const tokenPrefix = `inventory-token:${protocolVersion}`;

export function createInventory(initial) {
  const stock = new Map(Object.entries(initial));
  const tokens = new Set();

  function reserve(sku, quantity) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new RangeError(`quantity must be a positive safe integer, got ${quantity}`);
    }
    const current = stock.get(sku);
    if (typeof current !== 'number' || current < quantity) {
      return null;
    }
    stock.set(sku, current - quantity);
    tokenCounter += 1;
    const token = `${tokenPrefix}|${tokenCounter}|${sku}|${quantity}`;
    tokens.add(token);
    return token;
  }

  function release(token) {
    if (!tokens.has(token)) {
      return false;
    }
    tokens.delete(token);
    const sku = token.split('|')[2];
    const quantity = Number(token.split('|')[3]);
    stock.set(sku, stock.get(sku) + quantity);
    return true;
  }

  function available(sku) {
    const value = stock.get(sku);
    return typeof value === 'number' ? value : 0;
  }

  return {reserve, release, available};
}
