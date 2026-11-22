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
| 1 | The yardstick | `npm run score` prints precision, recall, coverage; sealed key drafted; DB1 baseline written down | built; PR #7 open with tests passing, waits on James to merge (this session may not merge to main) |
| 2 | Fee reader, one family | overdraft, NSF and monthly maintenance read end to end, >= 97% precision on the sealed key | in progress on branch claude/m2-reader: Knox's plain-code candidate finder v1 reads every family at 63.4% precision, 75.0% recall on the sealed key (docs/knox.md); Knox's model check built (docs/knox.md), first run waits on the key |
| 3 | All core families | >= 97% precision, >= 85% recall on the sealed key | |
| 4 | Scale and freshness | >= 90% of the universe, nothing older than 90 days | |
| 5 | Cutover | the site reads DB2 and the score stays above the gate | needs James |

## Baselines (DB1's live fees, published_fee_catalog, copied 2026-11-21)
| Key | Precision | Recall | Coverage |
|---|---|---|---|
| Practice key (DB1's 62 confirmed institutions, 2,147 scored lines) | 70.3% (68.2 to 72.4) | 59.2% (57.1 to 61.3) | 100% |
| Sealed key `key-2026-11-21` (30 random institutions, 1,456 scored lines; not yet confirmed by a person) | 87.9% (85.4 to 90.0) | 46.4% (43.9 to 49.0) | 100% |

## DB2 reader scores
| Version | Key | Precision | Recall | Coverage |
|---|---|---|---|---|
| Knox candidate finder v1, no model (2026-11-21) | Practice key | 60.5% | 75.8% | 100% |
| Knox candidate finder v1, no model (2026-11-21) | Sealed key `key-2026-11-21` (still drafting) | 63.4% (61.1 to 65.6) | 75.0% (72.7 to 77.2) | 100% |

Model steps use Sonnet 5.5 (`claude-sonnet-5-5`) with a $200 total cap; any single run over $25 needs James's yes (James, 2026-11-21). James sets the key himself as an environment variable of the cloud environment the runs happen in; see docs/model-wrapper.md.

## Where DB1 loses accuracy (2026-11-21 review)
Traced on the practice key: of 2,305 key fees, 64.7% are live at the right price. Losses: 9.6% thrown out by verification, 9.6% shown only at another price for the same fee type (no product or tier identity), 6.2% filed under the wrong fee type, 5% percentage fees kept off the site, 3.0% taken down after going live, 3.4% never read, about 1% not in stored text. Full write-up: the Claude Doc "How the FeeInsight pipeline works and where it loses accuracy". DB2 must carry product and tier identity, keep percentage fees, and never drop a quoted fee silently.

## Waiting on James
- Check 20% of the sealed key (6 institutions) so it can be sealed.
- Access to the DB2 Supabase project: the connector here sees only DB1's project.
- Freeze of DB1 (auto-merge, lanes, feature work): a change to the live system, so his call.
