# Sources: find, then standardize

A bank's fees are rarely in one document. DB2 finds every source a bank has, labels each one, and
turns each into the same standard record before anything is read. The plan of record has the full
reasoning; this file defines the labels the database uses (`0002_source_labels.sql`).

## Find tiers (`institutions.find_tier`)
1. Direct: a menu or footer link named fees, fee schedule, disclosures or rates.
2. Crawl: the site map, disclosure, forms and resources pages, and every linked PDF.
3. Browser: pages that need a real browser (JavaScript, tabs, accordions, viewers).
4. Assembled: no single schedule; fees are collected from partial sources.
5. Not published: recorded with what was checked, and retried on a schedule.

`institutions.source_status` is `found`, `assembled`, `not_published`, or `blocked_for_automation`
when the site says no to automated visitors.

## The review list (`source_review_list`)
Institutions that are blocked for automation or publish nothing are never dropped. They appear in
the review list with the reason and what was checked. A person can clear one by supplying the
source file or link, which is stored with `fetched_via = 'manual'` and then read like any other.

## Format (`source_documents.format`): how the source becomes text
| Label | Meaning |
|---|---|
| `text_pdf` | PDF with real text |
| `image_pdf` | Scanned or picture-only PDF; needs image reading |
| `shapes_pdf` | PDF whose text is drawn as shapes; looks like text, has none; needs image reading |
| `web_page` | Plain web page |
| `js_page` | Page built by JavaScript; rendered in a browser first |
| `tabbed_page` | Page with tabs, accordions or "show more"; every panel opened first |
| `embedded_viewer` | Viewer or flipbook; the file behind it is fetched |
| `image` | Picture of a fee table |
| `office_file` | Word or Excel download |
| `other` | Anything else; described in `notes` |

## Content kind (`source_documents.content_kind`): what the source can be trusted for
| Label | Meaning |
|---|---|
| `consumer_fee_schedule` | The full list of consumer service fees |
| `business_fee_schedule` | Business fees |
| `combined_fee_schedule` | One schedule covering consumer and business |
| `rates_and_fees_sheet` | Fees mixed with interest rates |
| `disclosure_booklet` | Truth in Savings or account disclosure booklet |
| `product_page` | One account's monthly fee, minimum balance and waiver |
| `comparison_chart` | The same for several accounts, in columns |
| `faq_page` | Single fees stated in answers |
| `overdraft_disclosure` | Overdraft and returned-item fees, limits and caps |
| `single_service_page` | Fees for one service (wires, safe deposit boxes, cards) |
| `fee_change_notice` | Changes to a schedule, with an effective date |
| `account_agreement` | Account agreement or terms |
| `cra_public_file` | Community Reinvestment Act "Products and Services" file |
| `newsletter_or_handbook` | Member newsletter or handbook that repeats fees |
| `out_of_scope` | Loan, mortgage or trust material; recorded so it is not fetched again |
| `other` | Anything else; described in `notes` |

## Other labels
- `role`: `primary` (at most one per institution), `supporting`, `superseded`, `out_of_scope`.
- `link_status`: `linked`, `orphan` (on the bank's server, but no page links to it, so it cannot
  be proven current), `unknown`.
- `printed_date`: the effective or revision date exactly as printed. It is recorded, not judged.
- When two sources of one bank state different prices for the same fee, both are kept and the
  conflict is recorded. The fee schedule's price is the one published, with a note.

The lists came from a hand check of the 30 answer-key institutions on 2026-11-11 and will change
as more banks are labelled.
