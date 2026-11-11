# FeeInsight DB2

DB2 is a new, independent fee data system for Fee Insight. It is built, tested against a sealed
answer key, and only then switched on, bank by bank. The plan of record is the Claude Doc
"FeeInsight DB2: what's wrong and the plan" (https://claude.ai/artifact/MQsdZYfapynR3ST6Mk2rNC).
Where this file and the plan disagree, the plan wins; fix this file.

## Hard rules
- Independent. Never copy, import or vendor code from the `feeinsight.com` repository (DB1).
  DB2 may read DB1 data only through a read-only copy; it never writes to DB1.
- Small. The whole fee reader stays under 5,000 lines of non-test code. A PR that would push it
  over says so and needs James's yes.
- No on/off switches. A change either passes the frozen test cases and goes live, or it does not
  merge. No `*_LIVE` flags, no dry-run modes left behind.
- The answer key is sealed. Tables in the `sealed` schema are read only by the scorer. Reader code,
  prompts and tests never read them, and no one tunes the reader on a sealed institution.
- Every number has a source. A fee is kept only if its exact quote appears in the stored
  document text and its amount appears in that quote. Plain code checks this, not a model.
- Never fake records, counts or results. If a number is unknown, say so.
- Never feature or audit Frost Bank or Space Coast Credit Union.
- One model wrapper with a hard spend cap. Spend above the cap needs James's yes.

## How work runs
- One outcome per PR, on a branch, reviewed before merge. No direct pushes to `main`,
  no force-pushes, no branch deletion.
- The database schema lives only in `supabase/migrations/`, numbered `NNNN_name.sql`, one higher
  than the last. Nothing is typed straight into the database.
- Migrations are applied to the DB2 Supabase project (`feeinsight-db2`, org FeeInsight.comV2)
  only after the PR is merged.
- Plain words in docs and PR descriptions. James reads them.
