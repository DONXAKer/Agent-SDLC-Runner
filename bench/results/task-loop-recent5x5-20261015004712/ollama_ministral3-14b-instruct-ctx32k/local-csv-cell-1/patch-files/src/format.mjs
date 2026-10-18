export const protocolVersion = 1;

export function csvRow(values) {
    if (!values.length) return '';
    
    return values.reduce((acc, value) => {
        const needsQuotes = typeof value === 'string' 
            && (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r'));
        
        let csvValue = typeof value === 'string' 
            ? value.replace(/"/g, '""')
            : value.toString()
            .replace(/"/g, '""');
        
        csvValue = needsQuotes ? `"${csvValue}"` : csvValue;
        
        acc.push(csvValue);
        return acc;
    }, []).join(',');
}