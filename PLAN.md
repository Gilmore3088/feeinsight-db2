# Where DB2 stands

The plan of record is the Claude Doc "State of FeeInsight" (consultant-grade bar and phases).
This file is the running log, so any session can pick up from here. Keep it short.

## The bar (all seven, two weekly runs in a row)
Precision >= 97% and recall >= 85% on the sealed key; sealed key of >= 30 random institutions with
>= 20% checked by a person; every fee with a stored document, exact quote and fetch date; every
published fee from a document fetched in the last 90 days; >= 90% of a defined universe covered;
no weekly precision drop of more than 1 point.

## Milestones
| # | Milestone | Done when | State |
|---|---|---|---|
| 1 | The yardstick | `npm run score` prints precision, recall, coverage; sealed key drafted; DB1 baseline written down | in review (PR 7) |
| 2 | Fee reader, one family | overdraft, NSF and monthly maintenance read end to end, >= 97% precision on the sealed key | next |
| 3 | All core families | >= 97% precision, >= 85% recall on the sealed key | |
| 4 | Scale and freshness | >= 90% of the universe, nothing older than 90 days | |
| 5 | Cutover | the site reads DB2 and the score stays above the gate | needs James |

## Baselines (DB1's live fees, published_fee_catalog, copied 2026-11-21)
| Key | Precision | Recall | Coverage |
|---|---|---|---|
| Practice key (DB1's 62 confirmed institutions, 2,147 scored lines) | 70.3% (68.2 to 72.4) | 59.2% (57.1 to 61.3) | 100% |
| Sealed key `key-2026-11-21` | pending | pending | pending |

## Waiting on James
- Check 20% of the sealed key (6 institutions) so it can be sealed.
- Access to the DB2 Supabase project: the connector here sees only DB1's project.
- Freeze of DB1 (auto-merge, lanes, feature work): a change to the live system, so his call.
