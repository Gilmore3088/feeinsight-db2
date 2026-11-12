# FeeInsight DB2

A new, independent fee data system for Fee Insight, built to replace the current pipeline only
after it proves better on a sealed answer key.

Plan: "FeeInsight DB2: what's wrong and the plan" (https://claude.ai/artifact/MQsdZYfapynR3ST6Mk2rNC).

## What is here now
- `supabase/migrations/0001_answer_key.sql`: the tables for the sealed answer key (stage 2 of the
  plan).
- `supabase/migrations/0002_source_labels.sql`: source labels, find tiers and the source review list.
- `docs/answer-key.md`: how the answer key is drawn, recorded, confirmed and used.
- `docs/sources.md`: how sources are found in tiers and labelled.
- `src/deming/score.ts`: the scorer (plain code). Rules in `docs/scoring.md`. Run the tests with `npm test`.
- `src/model/wrapper.ts`: the one model wrapper with a hard spend cap. See `docs/model-wrapper.md`.
- `src/rosetta/convert.ts`: the converter (plain code) that turns every stored source into one standard
  record of text before any fee is read. See `docs/converter.md`. Needs `pdftotext` and `pdfinfo` (poppler).
- `supabase/migrations/0003_standard_sources.sql`: the table for that standard text, one row per page.
- `src/fees/`: the fee record, the full quote check and the publish rule (plain code). See
  `docs/fee-record.md`. `supabase/migrations/0004_fees.sql` is the table: one row per price, never deleted.

## Order of work
1. Answer key: draw 30 random institutions, record every fee line, a person confirms 20%.
2. Fee reader: reads the stored original documents, under 5,000 lines.
3. Scoring: the reader's output against the sealed key. Cutover needs 97% precision and 85% recall,
   beating today's live fees.
4. Read layer and public-data loaders.
5. Cutover in waves, with today's system as the fallback.

Rules for anyone working here are in `CLAUDE.md`.
