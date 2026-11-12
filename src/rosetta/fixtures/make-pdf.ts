// Test helper: builds a tiny, valid PDF by hand so the tests need no stored binary file.
// Each page is a list of text items placed at x, y (points from the bottom left).
// `garbled: true` draws the item with a font whose text layer maps every letter to a
// private-use character, the way a broken text layer looks to a text extractor.

export interface PdfItem { x: number; y: number; text: string; garbled?: boolean }

const escape = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c);

export function makePdf(pages: PdfItem[][]): Buffer {
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Broken def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    '1 beginbfrange <21> <7E> <E021> endbfrange',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const stream = (body: string) => `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '', // the page list, filled in below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >>',
    stream(cmap),
  ];
  const kids: string[] = [];
  for (const items of pages) {
    const body = items
      .map((it) => `BT /${it.garbled ? 'F2' : 'F1'} 10 Tf ${it.x} ${it.y} Td (${escape(it.text)}) Tj ET`)
      .join('\n');
    const pageNumber = objects.length + 1;
    kids.push(`${pageNumber} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageNumber + 1} 0 R ` +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>',
      stream(body),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
