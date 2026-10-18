export const protocolVersion = 1;

export async function settleSequentially(items, work) {
  const results = [];
  for (let index = 0; index < items.length; index++) {
    try {
      const value = await work(items[index], index);
      results.push({ok: true, value});
    } catch (error) {
      results.push({ok: false, error});
    }
  }
  return results;
}
