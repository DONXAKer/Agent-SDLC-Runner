export const protocolVersion = 1;

export const csvRow = (values) => {
  if (values.length === 0) return '';

  // Helper function to properly handle quoting and escaping
  const processValue = (cell) => {
    if (/[,\r\n]/.test(cell) || cell.includes('"')) {
      const escapedQuotes = cell.replace(/\"/g, '""'); 
      return `"${escapedQuotes}"`;
    }
    return cell;
  };

  return values.map(processValue).join(',');  
};
