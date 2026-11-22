// A text that was already taken from a document elsewhere (today's system keeps one per
// document) turned into the standard record, so the quote check can run on it.
// It is data copied read-only; no code of that system is used. Plain code, no model.

import { createHash } from 'node:crypto';
import type { StandardSource } from './convert.ts';

/** `pageStarts` holds the character where each PDF page begins (the first is 0). With no
 * page starts the text is one web page with no page number. */
export function storedTextSource(sourceDocumentId: number, text: string, pageStarts: number[] | null): StandardSource {
  const starts = (pageStarts ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n <= text.length).sort((a, b) => a - b);
  const pages = starts.length > 1 || (starts.length === 1 && starts[0] === 0)
    ? starts.map((s, i) => ({ page: i + 1, method: 'pdf_text' as const, text: text.slice(s, starts[i + 1] ?? text.length), needsImageReading: false }))
    : [{ page: null, method: 'html_visible' as const, text, needsImageReading: false }];
  return {
    sourceDocumentId, format: pages[0].page == null ? 'web_page' : 'text_pdf',
    fileSha256: createHash('sha256').update(text).digest('hex'), converterVersion: 'stored-text-1', pages,
    needsImageReading: false, textChars: text.length,
  };
}
