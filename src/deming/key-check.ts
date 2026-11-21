// The quote check run on the answer key itself: every key line must be in the stored text it
// claims, with its price inside the quote, exactly as a reader's fee must. Plain code, no model.

import { checkFee, type CheckResult } from '../fees/quote-check.ts';
import { storedTextSource } from '../rosetta/stored-text.ts';
import { asRecord, type KeyFile } from './key-file.ts';

export interface StoredText { text: string; pageStarts: number[] | null }

export interface KeyLineCheck { lineIndex: number; institutionId: number; result: CheckResult }

/** Check every line. A line on a paged text with no page given takes the first page that holds
 * its quote (`fillPages`), so a recorder need not count pages by hand. */
export function checkKeyLines(k: KeyFile, texts: Map<number, StoredText>, fillPages = false): KeyLineCheck[] {
  return k.lines.map((l, lineIndex) => {
    const t = texts.get(l.textId);
    if (!t) return { lineIndex, institutionId: l.institutionId, result: { ok: false, problems: [`the stored text ${l.textId} is missing`], page: null } };
    const source = storedTextSource(l.textId, t.text, t.pageStarts);
    let result = checkFee(asRecord(l), source);
    if (!result.ok && fillPages && l.page == null && source.pages[0].page != null && result.page != null) {
      l.page = result.page;
      result = checkFee(asRecord(l), source);
    }
    return { lineIndex, institutionId: l.institutionId, result };
  });
}
