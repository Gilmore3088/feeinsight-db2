# How DB2 is scored

Deming owns the score. The scorer is plain code in `src/deming/score.ts`, with no model in it, and
it is the only scorer. It compares the fees a reader produced with the sealed answer key, one
institution at a time.

## The two numbers
- **Precision**: of the fees the reader produced, the share that are in the key with the same price.
- **Recall**: of the priced fees in the key, the share the reader found with the same price.

Each number is reported with a 95% range (Wilson interval), so a small key cannot pass for a
precise one. Cutover needs 97% precision and 85% recall, and a result clearly better than today's
live fees scored on the same key.

## How a reader fee is paired with a key line
1. Both must be for the same institution.
2. They must describe the same fee: their fee names, or their quotes, are at least 60% alike.
   Likeness is twice the number of shared words, divided by the words in both. Dollar amounts,
   percentages and words that say nothing about which fee it is ("fee", "charge", "per", "the"
   and the like) are left out. So "NSF fee" is not the same fee as "Safe deposit box NSF fee":
   a short name sitting inside a longer, different one does not count as a match. If both name
   a product and the product names share no word, the likeness is halved.
3. Each key line pairs with at most one reader fee and the other way round. Pairs with the same
   price are made first, then the most alike.

## What counts as what
| Case | Precision | Recall |
|---|---|---|
| Same fee, same price | counts for | counts for |
| Same fee, different price | counts against | counts against |
| Reader fee with no key line (a duplicate lands here) | counts against | no effect |
| Key line the reader did not find | no effect | counts against |

- Same price means the same kind of price (flat, rate, range, free) and the same numbers to the
  cent. A flat fee read as a range is a different price.
- Key lines with no stated amount ("varies", "at cost", penalties stated in days of interest) are
  not scored for recall. A reader fee is always counted, whatever its kind.
- On pairs that match, the scorer also counts consumer-against-business mix-ups and unit
  differences. These are reported beside the two numbers. The target for mix-ups is zero.
- Category is not scored yet. It joins the score when the fee record format (piece 12) fixes the
  category list.

## What the scorer never does
- It never reads reader code or prompts, and reader code never reads the `sealed` schema.
- It has no switches and no per-bank rules. A rule change here is a change to this page and the
  tests in `src/deming/score.test.ts` in the same pull request.
