// The first half of the quote check: plain code, no model. A quote counts as found only if,
// after the same tidy-up on both sides, it appears word for word in the stored text.
// (Checking that the amount appears in the quote is a later piece.)

import type { StandardSource } from './convert.ts';

/** One spelling for things that look the same: plain quotes, plain dashes, plain spaces,
 * and every run of white space as one space. Case and wording are kept. */
export function normalizeText(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[­​-‍⁠﻿]/g, '') // soft hyphens and zero-width marks
    .replace(/\s+/g, ' ') // \s covers non-breaking and other wide spaces
    .trim();
}

/** Is the quote in the source? Tries each page's text, then its second reading (altText).
 * `page` is the first page it was found on (null for a web page, or when not found). */
export function containsQuote(source: StandardSource, quote: string): { found: boolean; page: number | null } {
  const wanted = normalizeText(quote);
  if (!wanted) return { found: false, page: null };
  for (const p of source.pages) {
    if (normalizeText(p.text).includes(wanted) || (p.altText !== undefined && normalizeText(p.altText).includes(wanted))) {
      return { found: true, page: p.page };
    }
  }
  return { found: false, page: null };
}
