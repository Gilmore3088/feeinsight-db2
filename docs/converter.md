# The converter: every source becomes one standard record of text

Code: `src/rosetta/convert.ts` and `src/rosetta/normalize.ts`. Tests beside them (run with
`npm test`). Table: `supabase/migrations/0003_standard_sources.sql`.

This is Rosetta's plain-code tool. It calls no model. It runs before any fee is read, so every
later step (the reader, the quote check, the scorer) sees the same text for the same file.

## What goes in
One stored file and its format label from `docs/sources.md`:

```
convertSource({ filePath, format, sourceDocumentId })
```

To check a file by hand: `node src/rosetta/convert-cli.ts <file> <format>` prints the record.

## What comes out
One record for the file, with one entry per page:

- For the file: the document id, the format, the SHA-256 of the file, the converter version, the
  pages, whether any page needs image reading, and the number of text characters.
- For each page: the page number (PDF pages count from 1; a web page has no page number), how the
  text was taken (`pdf_text`, `html_visible` or `none`), the text, and whether the page needs image
  reading.

The converter version (`rosetta-convert-1`) changes whenever the same file could produce different
text. Old rows are kept, so a fee can always be traced to the exact text it was read from.

## What each format gets
| Format | What the converter does |
|---|---|
| `text_pdf` | Reads the text layer page by page with `pdftotext`. `text` keeps the layout, so a table row stays on one line. `altText` is the same page read without layout. Two-column pages scramble differently in each, so the quote check tries both. |
| `image_pdf`, `shapes_pdf` | Takes no text, even if the file has a text layer, because it cannot be trusted. Every page is marked for image reading. The page count comes from `pdfinfo`. |
| `image` | One page, no text, marked for image reading. |
| `web_page`, `js_page`, `tabbed_page` | Visible text of the stored `.html` file, as one page. See below. |
| `embedded_viewer`, `office_file`, `other` | **Not converted yet.** The record has no pages and a `notConverted` reason. Nothing is marked for image reading, because no decision has been made about them. |

## Web pages
- Dropped: scripts, styles, `noscript`, `template`, `svg`, the page head and comments.
- Kept: everything else, **including text in hidden tabs and closed accordion panels**, because
  fees often sit there. The converter does not judge what is hidden. This also keeps menus and
  footers; the reader has to tell them from fees.
- Each table row becomes one line, cells joined by one space, in reading order. A paragraph or
  line break inside a cell does not split the row. For a table inside a table, the rows of the
  inner table are the lines.
- Paragraphs, headings, list items and other blocks each end a line. Runs of spaces become one.
- Codes such as `&amp;` and `&#36;` are turned into their characters. A code the converter does not
  know is left as written.
- Text is not added. Two words that touch in the file, with only styling between them, touch in the
  output (a footnote mark after a word, or a number and its label drawn apart by the page's
  styling). For that reason the quote check ignores spacing when it compares a quote with the
  text: the words, their order, the amounts and the case must still match exactly.
- A file that is not valid UTF-8 is read as an old Windows page instead of failing.

## What is marked for image reading, and why
A page is marked when its text cannot be trusted. Reading those pages is a later piece and goes
through the model wrapper.

1. Every page of an `image_pdf`, `shapes_pdf` or `image`.
2. **Thin**: a `text_pdf` page with fewer than 20 letters. That is a blank page, a page number or a
   stray mark, not a fee page. A cover page with a very short title is also caught; that costs one
   image read and loses nothing.
3. **Garbled**: a `text_pdf` page where either
   - more than 1 in 10 visible characters are control, private-use or "unknown character" marks, or
   - fewer than half of the letters sit in ordinary words (three or more letters a to z with at
     least one vowel).

   Both are signs of a text layer that looks fine on screen but extracts as nonsense.

The text of a thin or garbled page is still stored, so a person can see why it was marked.

## A wrong label is refused, not converted
Before converting, the first bytes of the file are checked against the label. A file that starts
like a PDF with a web label, a web page with a PDF label, or anything that is not a picture with
`image` raises `FormatMismatchError`. A PDF the tools cannot open raises `ConvertError`. Nothing is
written in either case; the label or the file is fixed first.

## The quote check, first half
`normalizeText` makes text comparable: every run of white space becomes one space, curly quotes and
long dashes become plain ones, and hidden marks (soft hyphens, zero-width spaces) are removed.
Wording and upper and lower case are kept.

`containsQuote(source, quote)` says whether a quote appears, after that tidy-up on both sides, in
any page's text or its second reading, and on which page. A quote is never matched across two
pages. Checking that the amount appears in the quote is the second half, in
`src/fees/quote-check.ts` (`docs/fee-record.md`).

## What this does not do yet
- Read pages marked for image reading.
- Convert viewers, Word and Excel files, or `other`.
- Write to the database. `0003_standard_sources.sql` defines the table (one row per page); the code
  that stores records comes with the piece that runs Rosetta.
- A web page with no visible text (a JavaScript page stored before it was rendered) comes out with
  zero characters and is not marked for image reading. Whoever runs the converter should treat zero
  characters as "fetch again in a browser".
