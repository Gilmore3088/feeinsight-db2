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
  // White space is dropped on both sides before comparing: a web page can run two cells or
  // spans together ("$0monthly"), and a PDF can split one row over lines. Words, order,
  // amounts and case must still match exactly.
  const squash = (t: string) => normalizeText(t).replace(/ /g, '');
  const wanted = squash(quote);
  if (!wanted) return { found: false, page: null };
  for (const p of source.pages) {
    if (squash(p.text).includes(wanted) || (p.altText !== undefined && squash(p.altText).includes(wanted))) {
      return { found: true, page: p.page };
    }
  }
  return { found: false, page: null };
}
