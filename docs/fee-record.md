# The fee record, the quote check and the publish rule

Code: `src/fees/record.ts`, `src/fees/quote-check.ts`, `src/fees/publish.ts`. Tests:
`src/fees/fees.test.ts` (run with `npm test`). Table: `supabase/migrations/0004_fees.sql`.

All of this is plain code. It calls no model, and it has no switches and no trial mode.

## The record: one row per price
A document line that holds two prices (a consumer price and a business price, say) becomes two rows.

| Field | Required | What it holds |
|---|---|---|
| Institution | yes | Who charges the fee. |
| Source document and page | yes | The stored document the fee was read from, and the page. No document, no fee. A web page has no pages, so its page is left empty. |
| Quote | yes | The bank's exact words that hold the fee's name and its price. |
| Fee name | yes | As the bank writes it. |
| Category | no | From one fixed list. Empty means "not yet sorted". It is never a guess. The list itself is a later piece. |
| Price kind | yes | `flat`, `rate`, `range`, `free` or `varies`. |
| Amount, highest amount, percent | by kind | As printed. See the rules below. |
| Unit | yes | `per_item`, `per_day`, `per_month`, `per_quarter`, `per_year`, `per_statement`, `one_time`, `per_hour` or `other`. |
| Conditions | no | Tiers, waivers, limits and minimums, as written. |
| Product | no | The account the fee applies to, if the document names one. |
| Audience | yes | `consumer`, `business`, `both` or `unknown`. |
| Document date | no | The date printed on the document, as printed. |
| Read on, and by which run | yes | When the fee was read, and the run that read it. |
| Status | yes | `read`, `checked`, `live` or `withdrawn`. A withdrawn fee must say why. |

The table also keeps when the quote check last passed and which version of the check it was.

### Rules for the numbers
- **Flat** needs an amount.
- **Range** needs a lowest and a highest amount, and the highest cannot be below the lowest.
- **Rate** needs a percent, and holds no dollar amount. A minimum or a cap that comes with a
  percent ("3%, $10 minimum") goes in the conditions.
- **Free** has an amount of zero or none.
- **Varies** needs no number.
- A percent fee is never mixed with dollar fees: only a rate row holds a percent.
- No number is below zero.

The database refuses a row that breaks these rules, and `validateFee` gives the same answers in
plain words before a row is written.

### A fee is never deleted
The table refuses deletes with the message "fees are withdrawn, never deleted". A fee that should
come down is set to `withdrawn` with a reason, and the row stays.

### The same shape as the answer key
`toFeeLine` hands a fee to Deming's scorer with the same fields the answer key has (institution,
name, quote, price kind, the three numbers, unit, product, audience), so the scorer compares like
with like.

## The quote check
`checkFee(fee, text of its document)` answers pass or fail, lists every problem in plain words, and
names the page the quote was found on. It passes only when **all** of these hold:

1. The record is valid (the rules above).
2. The text is the text of the fee's own source document.
3. The quote is in that text, word for word. Spacing, curly quotes and long dashes are ignored;
   wording, amounts and upper and lower case are not (`docs/converter.md`). A quote is never
   matched across two pages.
4. The quote is on the page the fee claims. If the same words are on several pages, the claimed
   page must be one of them. For a web page, the fee must claim no page.
5. That page's text is trusted. A page marked for image reading fails, because its text layer is
   missing or garbled. This changes when image reading is built and such a page carries text
   taken by that method.
6. The price is inside the quote (next section).
7. The quote names the fee: at least one word of three or more letters from the fee name is in the
   quote, ignoring case. The words "fee", "charge", "the", "and", "for", "per" and "each" do not
   count, unless the name has no other word. A name with no word that long ("PO") must appear whole.

The check has a version, `quote-check-1`. It changes whenever the same fee and text could get a
different answer.

### What counts as the price being in the quote
Every number stored on the fee must be found in the quote, compared as a number, never as a piece
of a longer number.

**A dollar figure is**
- a number after a dollar sign: `$30`, `$30.00`, `$1,500`, `$1,500.00`, `$.50`;
- a number with no sign that has a point and exactly two digits after it: `30.00`, `1,500.00`;
- a number before a cents mark: `25¢`, `25 cents` (read as $0.25).

**Not a dollar figure**
- A bare whole number: `30 days`, `300`, `1,500`. So a $30 fee whose quote holds only "30 days"
  fails.
- A number before `%` or `percent`. That is a percent and never stands in for dollars.
- A number with misplaced commas: `$1,50`, `$10,20,30`. It is not read at all.

Some cases worth knowing:
- $30 does not match `$300`, `$130.00`, `$30.50` or `30%`.
- `$1.500` is read as it is written, one dollar fifty. It matches a fee of $1.50, not $1,500.
- **Range**: both ends must be dollar figures in the quote. One exception: a range that starts at
  zero ("up to $20") need not show the zero, when the quote or the conditions say "up to", "not to
  exceed", "no more than", "maximum" or "max". The top end must still be found.
- **Rate**: the percent must be in the quote as a percent: `1.5%`, `1.50 %`, `1.5 percent`.
- **Free**: the quote must say so, as a whole word: free, no charge, no fee, n/c, waived, included,
  complimentary, none, or a dollar figure of zero (`$0`, `$0.00`). "Freedom" and `$0.50` do not count.
- **Varies**: no number is needed, but the quote must be at least two words. If a number is stored
  anyway, it must be in the quote like any other.

### What the check proves
- The words exist in the bank's own stored document, on the page named.
- Every number on the fee is printed in those words, in the right form (dollars or percent).
- The words mention the fee by name.

### What the check cannot prove
- **That the quote is about this account or this fee.** A real line from the business schedule can
  be filed as a consumer fee and still pass. So can a real "$30" line whose fee name shares one word
  with a different fee.
- **That the number is the price.** "Stop payment $30.00 per item, 12.00 minimum balance" holds two
  dollar figures; either would pass as the amount. A free fee whose quote says "toll-free" passes
  the free rule.
- **That the unit, audience, product, conditions, category or document date are right.** None of
  them is checked against the text.
- **That the fee is current.** The check reads the stored document, not the bank's website today.
- **That nothing was missed.** It checks fees that were read, not fees that were not.
- A web page can run two cells together ("$30.0012 items"). The check then cannot read the figure
  and the fee fails. That is the safe direction: a real fee is held back, a wrong one is not let in.

Precision and recall against the sealed answer key (`docs/scoring.md`) are what measure these gaps.

## The publish rule
`nextStatus(fee, check result)` says where a fee goes after a quote check. One step at a time:

| From | Check passes | Check fails |
|---|---|---|
| `read` | `checked` | stays `read` |
| `checked` | `live`, if the check it passed before is today's version; otherwise stays `checked` | back to `read` |
| `live` | stays `live` | `withdrawn`, with what the check found as the reason |
| `withdrawn` | stays `withdrawn` | stays `withdrawn` |

- A fee cannot go from `read` to `live` in one step. It takes two passes of the check.
- `canGoLive` is the only door to `live`: the fee is `checked`, still a valid record, and its
  recorded pass is the current version of the check.
- `withdraw(fee, reason)` takes a fee down from any status. It refuses an empty reason.
- Withdrawn is final. A fee that comes back is read again as a new row.
- `applyCheck` records the result on the fee: a pass stamps the time and the version; a fail
  clears the stamp.

## What this does not do yet
- Write to the database. The table is defined; the code that stores and updates rows comes with the
  piece that runs the reader.
- Sort fees into categories. The category list is a later piece.
- Read pages marked for image reading.
