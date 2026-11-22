# The sealed answer key

The answer key is how DB2 is judged. It is built before the fee reader exists and is never shown
to whoever builds the reader.

## The draw
- 30 institutions: 15 banks and 15 credit unions, picked at random from active institutions that
  have a stored fee document.
- Excluded: Frost Bank, Space Coast Credit Union, and every institution that was used to tune or
  check today's system (the 62-bank answer key, the 8-bank cohort, weekly live-check banks and
  banks audited by hand).
- The random seed and the rule are stored in `sealed.key_sets`, so anyone can repeat the draw.

## Recording
- Every fee line on the institution's own current document is recorded in `sealed.key_lines`, with
  the exact quote, the page, the price, the unit, conditions, product and audience.
- Expected size: roughly 900 to 1,200 lines. This is an estimate.

## Confirming
- A person checks a random 20% of the institutions, line by line, against the document, in
  `sealed.key_confirmations`.
- If 98% or more of the checked lines agree and few lines were missed, the key is sealed.
  Otherwise every institution is checked.
- A model can draft lines. Only a person can confirm them.

## Using it
- Only the scorer reads the `sealed` schema. It reports precision (share of the reader's fees that
  match a key line) and recall (share of key lines the reader found).
- Cutover needs 97% precision and 85% recall, beating today's live fees by more than the margin of
  error, then a fresh key a month later to confirm.
- A key is retired once its results have been used to change the reader.

## Two keys: sealed and practice
- **Sealed key** (`kind: "sealed"`): the random draw above. It proves DB2. Nobody tunes on it.
- **Practice key** (`kind: "dev"`): DB1's own answer key, the 62 institutions a person confirmed
  (2,305 lines). DB1 was tuned on these, so they cannot prove anything, but DB2 may tune on them
  freely. Built with `node src/copy/db1-cli.ts practice-key`.

## Key files
Until the DB2 database is reachable, a key is a JSON file in the shape of `src/deming/key-file.ts`,
field for field the same as the `sealed` tables, so it can be loaded as is later.
- Sealed key files are kept **out of this repository** (it is public), in the project's shared
  folder `feeinsight/sealed/`. The scorer is the only code that opens them; it takes the path as
  an argument.
- `validateKey` refuses a key whose lines break the price rules, point at a document the
  institution does not have, or carry a confirmation by a model. A sealed key is `sealed` only
  once a person has checked at least 20% of its institutions.
- `npm run key:check -- --key <key> --texts <texts>` runs the full quote check on every key line,
  exactly as on a reader's fee.

## The draw of 2026-11-21 (`key-2026-11-21`)
- Population: DB1 institutions that are open and have a stored text that DB1 classed as a fee
  schedule, 2,000 to 120,000 characters, fetched in the last 90 days. 1,533 banks and 2,147 credit
  unions.
- Excluded: DB1's 117 answer-key institutions, Frost Bank, Space Coast Credit Union. The 8-bank
  cohort and the weekly live-check banks could not be listed from here; if any was drawn, it is
  replaced.
- Order: within each charter, by `md5('key-2026-11-21:' || institution id)`. The first 15 of each
  are drawn. One whose stored texts hold no real fee schedule is replaced by the next rank of the
  same charter, and the reason is kept.
- Recorded from DB1's stored text of each document (a read-only copy), not from a fresh fetch,
  because this environment cannot reach bank websites. Each line names the stored text and its
  hash.
- Drafted by a session that does not build the reader; the session that builds the reader never
  opens the sealed files and sees only the score.
