// For people checking by hand: node src/rosetta/convert-cli.ts <file> <format>
// Prints the standard record as JSON.

import { convertSource, FORMATS, type Format } from './convert.ts';

const [filePath, format] = process.argv.slice(2);
if (!filePath || !FORMATS.includes(format as Format)) {
  console.error(`usage: node src/rosetta/convert-cli.ts <file> <format>\nformats: ${FORMATS.join(', ')}`);
  process.exit(2);
}
try {
  console.log(JSON.stringify(convertSource({ filePath, format: format as Format }), null, 2));
} catch (err) {
  console.error(`${(err as Error).name}: ${(err as Error).message}`);
  process.exit(1);
}
