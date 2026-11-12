// Rosetta's converter: plain code, no model. It turns one stored source document into one
// standard record of text, before any fee is read. Text is taken only where it can be
// trusted; everything else is marked for image reading, which is a later piece.
// Rules are written out in docs/converter.md. Change them there and here together.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Changes whenever the text this file produces for the same input could change. */
export const CONVERTER_VERSION = 'rosetta-convert-1';

export const FORMATS = ['text_pdf', 'image_pdf', 'shapes_pdf', 'web_page', 'js_page', 'tabbed_page',
  'embedded_viewer', 'image', 'office_file', 'other'] as const;
export type Format = (typeof FORMATS)[number];

export type Method = 'pdf_text' | 'html_visible' | 'none';

export interface StandardPage {
  page: number | null;        // PDF page from 1; 1 for a single picture; null for a web page
  method: Method;
  text: string;
  altText?: string;           // PDF only: the same page read without layout
  needsImageReading: boolean;
}

export interface StandardSource {
  sourceDocumentId: number | null;
  format: Format;
  fileSha256: string;
  converterVersion: string;
  pages: StandardPage[];
  needsImageReading: boolean; // true when any page needs it
  textChars: number;          // characters of `text` over all pages
  notConverted?: string;      // set when this format is not converted yet; says why
}

export interface ConvertInput { filePath: string; format: Format; sourceDocumentId?: number | null }

export type FileKind = 'pdf' | 'html' | 'image' | 'office' | 'unknown';

/** The label says one kind of file and the first bytes say another. */
export class FormatMismatchError extends Error {
  format: Format; found: FileKind;
  constructor(format: Format, found: FileKind) {
    super(`label says ${format} but the file looks like ${found}`);
    this.format = format; this.found = found;
    this.name = 'FormatMismatchError';
  }
}

/** A PDF tool could not read the file (damaged, locked or not really a PDF inside). */
export class ConvertError extends Error {
  constructor(message: string) { super(message); this.name = 'ConvertError'; }
}

const PDF_FORMATS: Format[] = ['text_pdf', 'image_pdf', 'shapes_pdf'];
const HTML_FORMATS: Format[] = ['web_page', 'js_page', 'tabbed_page'];
const NOT_CONVERTED: Partial<Record<Format, string>> = {
  embedded_viewer: 'a viewer page holds no fee text itself; the file behind it must be fetched and labelled',
  office_file: 'Word and Excel files are not converted yet',
  other: 'no converter for this kind of source yet',
};

/** What the first bytes of a file say it is. */
export function sniffKind(bytes: Buffer): FileKind {
  const head = bytes.subarray(0, 4096);
  const hex = head.subarray(0, 8).toString('hex');
  if (head.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (hex.startsWith('89504e47') || hex.startsWith('ffd8ff') || hex.startsWith('47494638') ||
      hex.startsWith('49492a00') || hex.startsWith('4d4d002a') ||
      (hex.startsWith('52494646') && head.subarray(8, 12).toString('latin1') === 'WEBP')) return 'image';
  if (hex.startsWith('504b0304') || hex.startsWith('d0cf11e0')) return 'office';
  const start = head.toString('latin1').replace(/^(ï»¿)?\s+/, '');
  if (/^<(!doctype|!--|\?xml|[a-z])/i.test(start) || /<(html|head|body|div|table|p)[\s>]/i.test(start)) return 'html';
  return 'unknown';
}

// ---------- PDF ----------

const MIN_LETTERS = 20;       // a page with fewer letters than this has no real text
const MAX_BAD_SHARE = 0.1;    // share of visible characters that may be unreadable
const MIN_WORD_SHARE = 0.5;   // share of letters that must sit in ordinary words

/** Thin: fewer than 20 letters on the page (a blank page, a page number, a stray mark). */
export function isThin(text: string): boolean {
  return (text.match(/\p{L}/gu) ?? []).length < MIN_LETTERS;
}

/** Garbled: more than 1 in 10 visible characters are control, private-use or replacement
 * characters, or fewer than half the letters sit in ordinary words (three or more of a-z
 * with at least one vowel). */
export function isGarbled(text: string): boolean {
  const visible = text.replace(/\s/g, '');
  if (!visible) return false;
  const bad = (visible.match(/[\p{Cc}\p{Co}\p{Cn}�]/gu) ?? []).length;
  if (bad / [...visible].length > MAX_BAD_SHARE) return true;
  const letters = (visible.match(/\p{L}/gu) ?? []).length;
  if (letters < MIN_LETTERS) return false; // too little to judge; the thin rule covers it
  const inWords = (text.match(/[a-z]{3,}/gi) ?? []).filter((w) => /[aeiouy]/i.test(w)).join('').length;
  return inWords / letters < MIN_WORD_SHARE;
}

function run(tool: string, args: string[]): string {
  try {
    return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new ConvertError(`${tool} is not installed (it comes with poppler)`);
    const said = String(err?.stderr ?? '').trim().split('\n')[0];
    throw new ConvertError(`${tool} could not read the file${said ? `: ${said}` : ''}`);
  }
}

function pdfPageCount(filePath: string): number {
  const pages = Number(/^Pages:\s+(\d+)/m.exec(run('pdfinfo', [filePath]))?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new ConvertError('pdfinfo reported no pages');
  return pages;
}

/** Text of every page. pdftotext ends each page with a form feed; if that count is off, ask page by page. */
function pdfPageTexts(filePath: string, pages: number, layout: boolean): string[] {
  const flags = layout ? ['-layout', '-enc', 'UTF-8'] : ['-enc', 'UTF-8'];
  const parts = run('pdftotext', [...flags, filePath, '-']).split('\f');
  if (parts.length === pages + 1 && parts[pages].trim() === '') return parts.slice(0, pages);
  return Array.from({ length: pages }, (_, i) =>
    run('pdftotext', [...flags, '-f', String(i + 1), '-l', String(i + 1), filePath, '-']).replace(/\f/g, ''));
}

const tidy = (s: string) => s.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');

function convertPdf(filePath: string, format: Format): StandardPage[] {
  const count = pdfPageCount(filePath);
  if (format !== 'text_pdf') {
    // Scanned and drawn-as-shapes PDFs: whatever text layer exists is not trusted.
    return Array.from({ length: count }, (_, i) => ({ page: i + 1, method: 'none' as const, text: '', needsImageReading: true }));
  }
  const layout = pdfPageTexts(filePath, count, true);
  const plain = pdfPageTexts(filePath, count, false);
  return layout.map((raw, i) => {
    const text = tidy(raw);
    return { page: i + 1, method: 'pdf_text' as const, text, altText: tidy(plain[i]), needsImageReading: isThin(text) || isGarbled(text) };
  });
}

// ---------- HTML ----------

const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const BLOCKS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'ul', 'ol', 'dl', 'dt', 'dd',
  'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'blockquote', 'pre', 'form', 'fieldset', 'figure',
  'figcaption', 'address', 'details', 'summary', 'option', 'caption', 'thead', 'tbody', 'tfoot', 'title', 'body']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
  cent: '¢', sect: '§', deg: '°', para: '¶', dagger: '†', Dagger: '‡',
  times: '×', frac12: '½', frac14: '¼', frac34: '¾', plusmn: '±', shy: '­',
  eacute: 'é', ntilde: 'ñ', zwnj: '‌', zwj: '‍', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  check: '✓', minus: '−', le: '≤', ge: '≥', ne: '≠', prime: '′',
  sup1: '¹', sup2: '²', sup3: '³', euro: '€', pound: '£', divide: '÷',
};
// Numbers 128 to 159 are not real characters; old pages use them the way Windows does.
const WINDOWS: Record<number, string> = {
  133: '…', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•',
  150: '–', 151: '—', 153: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] !== '#') return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (WINDOWS[code]) return WINDOWS[code];
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

const TAG = /<(\/?)([a-z][^\s/>]*)(?:"[^"]*"|'[^']*'|[^'">])*>/iy;
const LOOSE_TAG = /<(\/?)([a-z][^\s/>]*)[^>]*>/iy; // for a tag with an unclosed quote

/** The text a person could see on the page, hidden panels included. One line per block or table row. */
export function htmlToVisibleText(html: string): string {
  const lines: string[] = [];
  let line = '';
  const inRow: boolean[] = []; // one entry per open table; true while inside one of its rows
  const endLine = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    line = '';
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { line += decodeEntities(html.slice(i)); break; }
    line += decodeEntities(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { i = after(html, '-->', lt + 4); continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { i = after(html, '>', lt); continue; }
    TAG.lastIndex = LOOSE_TAG.lastIndex = lt;
    const m = TAG.exec(html) ?? LOOSE_TAG.exec(html);
    if (!m) { // a bare "<" in text, or a tag that never ends
      if (/^<\/?[a-z]/i.test(html.slice(lt, lt + 3))) break;
      line += '<'; i = lt + 1; continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (DROPPED.has(name)) {
      if (closing || m[0].endsWith('/>')) continue;
      const rest = html.slice(i);
      const end = rest.search(new RegExp(`</${name}[\\s>]`, 'i'));
      const body = name === 'head' ? rest.search(/<body[\s>]/i) : -1; // a head that is never closed
      if (end >= 0 && (body < 0 || end < body)) i = after(html, '>', i + end);
      else i = body >= 0 ? i + body : html.length;
    } else if (name === 'table') {
      endLine();
      if (closing) inRow.pop(); else inRow.push(false);
    } else if (name === 'tr') {
      endLine();
      if (inRow.length) inRow[inRow.length - 1] = !closing;
    } else if (name === 'td' || name === 'th') {
      line += ' ';
    } else if (BLOCKS.has(name)) {
      // Inside a table row, a paragraph or line break in a cell must not split the row.
      if (inRow[inRow.length - 1]) line += ' '; else endLine();
    }
  }
  endLine();
  return lines.join('\n');
}

function after(html: string, mark: string, from: number): number {
  const at = html.indexOf(mark, from);
  return at < 0 ? html.length : at + mark.length;
}

function decodeBytes(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); } // not valid UTF-8: an old Windows page
}

// ---------- the one entry point ----------

export function convertSource(input: ConvertInput): StandardSource {
  const { filePath, format } = input;
  if (!FORMATS.includes(format)) throw new RangeError(`unknown format "${format}"`);
  const bytes = readFileSync(filePath);
  const base = {
    sourceDocumentId: input.sourceDocumentId ?? null,
    format,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    converterVersion: CONVERTER_VERSION,
  };
  const reason = NOT_CONVERTED[format];
  if (reason) return { ...base, pages: [], needsImageReading: false, textChars: 0, notConverted: reason };

  const kind = sniffKind(bytes);
  const expected: FileKind = PDF_FORMATS.includes(format) ? 'pdf' : HTML_FORMATS.includes(format) ? 'html' : 'image';
  if (kind !== expected) throw new FormatMismatchError(format, kind);

  let pages: StandardPage[];
  if (expected === 'pdf') pages = convertPdf(filePath, format);
  else if (expected === 'html') pages = [{ page: null, method: 'html_visible', text: htmlToVisibleText(decodeBytes(bytes)), needsImageReading: false }];
  else pages = [{ page: 1, method: 'none', text: '', needsImageReading: true }];

  return {
    ...base,
    pages,
    needsImageReading: pages.some((p) => p.needsImageReading),
    textChars: pages.reduce((n, p) => n + p.text.length, 0),
  };
}
