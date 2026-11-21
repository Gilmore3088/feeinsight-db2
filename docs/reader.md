# The plain-code reader (`src/reader/read.ts`)

Reads a document's stored text and writes one fee line per price, with the bank's exact words as the
quote. No model. It is the first stage of milestone 2; a model check of its rows comes next.

## What it reads
- **Table rows**: `Name | $5`, dot leaders (`Name ....... $5`), `Name – $5`, and short lines with
  no separator (`Stop Payment: $30.00/item`). The quote is the whole line.
- **Several prices in one row**: each price at the head of a price cell is its own row
  (`$20.00 $10.00`, `$35/$60`). Words further into the cell are conditions; their amounts are not read.
- **Two fees on one row** (`A | $5 | B | $20`): each price takes the name cells before it.
- **Product columns**: a header row of short cells with no prices names the columns; a fee with one
  price per column gets the column header as its product.
- **A price alone on its line** takes its name from the line before.
- **Headings** (a short line ending in a colon, or written like a title) are put in front of the name.
- **Prose**: a sentence that names a fee (fee, charge, assessed, ...) and holds a price.

## What it leaves out
- Amounts that read as conditions: a minimum balance, a limit, a daily maximum, "less than $X".
- Amounts of $1,000 or more, unless the name says fee or charge (they are balances).
- Rates in rate tables (APY, dividend, interest, APR); a percent counts only when the row names a fee.
- Rows that state a balance, an opening deposit or a limit and no fee.
- Free rows with a long name (account descriptions), and free or $0 amounts in prose.
- Loan, mortgage, home equity, escrow, appraisal, underwriting and trust fees: out of DB2's scope,
  the same scope the sealed key was drafted under (`sealed/DRAFTING.md`).
- "Varies" lines: they are not scored and would only lower precision.

## Scores (2026-11-21, reader v1)
| Key | Precision | Recall | Coverage |
|---|---|---|---|
| Practice key (62 institutions) | 60.5% | 75.8% | 100% |
| Sealed key `key-2026-11-21` (30 institutions, still drafting) | 63.4% (61.1 to 65.6) | 75.0% (72.7 to 77.2) | 100% |

The practice key is incomplete: in a hand check of 45 rows the reader found and the practice key
lacks, about 35 were real fees. So practice precision understates the reader; the sealed key, which
was drafted to hold every fee line, is the judge. The sealed key was scored twice for this version,
before and after the scope filter (62.5% / 75.4% before). Nothing was tuned on its lines.

## Known limits
- Two-column PDF text that the stored copy interleaves cell by cell reads badly.
- Text stored with no spaces between words (one practice document) cannot be split into fees.
- Units come from nearby words and often differ from the key; units are not part of the match.
