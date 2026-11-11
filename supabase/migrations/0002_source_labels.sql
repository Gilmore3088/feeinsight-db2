-- 0002_source_labels.sql
-- Steps one and two of the plan: find, then standardize.
-- Every source gets a format label and a content-kind label, and every
-- institution records how its sources were found. Adds columns only. No data.

alter table public.source_documents
  add column format text not null
    check (format in ('text_pdf', 'image_pdf', 'shapes_pdf', 'web_page', 'js_page', 'tabbed_page',
                      'embedded_viewer', 'image', 'office_file', 'other')),
  add column content_kind text not null
    check (content_kind in ('consumer_fee_schedule', 'business_fee_schedule', 'combined_fee_schedule',
                            'rates_and_fees_sheet', 'disclosure_booklet', 'product_page',
                            'comparison_chart', 'faq_page', 'overdraft_disclosure',
                            'single_service_page', 'fee_change_notice', 'account_agreement',
                            'cra_public_file', 'newsletter_or_handbook', 'out_of_scope', 'other')),
  add column role text not null default 'supporting'
    check (role in ('primary', 'supporting', 'superseded', 'out_of_scope')),
  add column link_status text not null default 'unknown'
    check (link_status in ('linked', 'orphan', 'unknown')),  -- orphan: on the bank's server, no page links to it
  add column fetched_via text not null default 'plain'
    check (fetched_via in ('plain', 'browser', 'manual')),  -- manual: a person supplied the file or link
  add column printed_date text,         -- the effective or revision date as printed, not judged
  add column click_path text,           -- how a person reaches it from the home page
  add column labelled_by text not null, -- who set the labels: a person, a session, or an agent run
  add column notes text;

-- One primary source at most per institution.
create unique index source_documents_one_primary
  on public.source_documents (institution_id) where role = 'primary';

alter table public.institutions
  add column find_tier smallint check (find_tier between 1 and 5),
    -- 1 direct link, 2 crawl, 3 real browser, 4 assembled from partial pages, 5 not published
  add column source_status text not null default 'not_searched'
    check (source_status in ('not_searched', 'found', 'assembled', 'not_published', 'blocked_for_automation')),
    -- blocked_for_automation: the site says no to automated visitors, so DB2 does not fetch it.
    -- These are never dropped: they sit in the review list until a person supplies the source.
  add column source_checked_at timestamptz,
  add column source_notes text;

-- The review list: every institution a person should look at, with the reason.
-- A person can clear a row by supplying the source (fetched_via = 'manual').
create view public.source_review_list with (security_invoker = true) as
select i.id, i.name, i.charter_type, i.state, i.website_url,
       i.source_status as reason, i.find_tier, i.source_checked_at, i.source_notes
from public.institutions i
where i.source_status in ('blocked_for_automation', 'not_published')
order by i.source_status, i.total_assets_usd desc nulls last;
