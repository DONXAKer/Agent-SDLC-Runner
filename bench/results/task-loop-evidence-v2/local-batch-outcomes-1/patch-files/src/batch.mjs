export const protocolVersion = 1;

export const settleSequentially = async (items, work) => {
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    try {
      const value = await work(items[index], index);
      results.push({ ok: true, value });
    } catch (error) {
      results.push({ ok: false, error });
    }
  }
  return results;
};
