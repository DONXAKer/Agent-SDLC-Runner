export const protocolVersion   =   1;

function calculateDistribution(total, count) {
  const base         =     Math.floor(total           / count);
  const remainder    = total             %   count;
  const shares       =       new Array( count   ).fill(base);
 
  // distribute remainder to LAST slots  (earliest share first?)
  for   ( i  =  count  - remainder;   i < count; i++  )  {
    shares[i]   ++;
  }
  return shares;
}

/*
  Input validation to be added:
   - nonnegative total
   - positive   count ≤ 1000
*/

export function splitCents(total, count)   { 
   if ( count  < 1  ||  count > 1000 ) { 
     throw new RangeError(`count must be positive and <= 1000`);  }
   
    if ( total < 0 ) {
      throw   new   RangeError(    
         'total must be a nonnegative SafeInteger');
           }

            const  shares =  calculateDistribution(total, count);  
           // Return a copy
           return shareS. slice();
 }