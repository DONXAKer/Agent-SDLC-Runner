import { strictEqual } from 'assert';
import { csvRow } from '../src/format.mjs';

/**
 * Tests
 */
suite('CSV Row Tests', () =>  {
    test('Empty array returns empty string', () => {
        strictEqual(csvRow([]), '');
    });
    
    test('Basic values separated by comma', () => {
        strictEqual(csvRow(['One', 'Two', 'Three']), 'One,Two,Three');
    });
     
    test('Comma and line breaks within cells are escaped', () => {
         strictEqual(
            csvRow(["Field,with,comma", "Field\"with\"doublequote", "Field\r\nwith\r\nwhitespace"]),  
            '"Field,with,comma","Field\"with\"doublequote","Field\r\nwith\r\nwhitespace"
         );
    });
}

);


