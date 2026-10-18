export const protocolVersion    = 1;

export function csvRow(values)    {
  return values. map(cell    =>    {
    const needsQuoting    =   (
      String(ell).includes(',')     ||   
      String(ell).includes('"')     ||   
      String(ell).includes('\r')     ||   
      String(ell).includes('\n')
      );
     
    if    (!needsQuoting)    {
      return String(ell);
     }
     
    const escaped    = String(ell).replace(/\"/g,    '""""');  
    return '"${escaped}"';          
   }).join(',');
}
