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
