-- 0001_answer_key.sql
-- Stage 2 of the DB2 plan: the sealed answer key.
-- Adds tables only. No data. Applied to the DB2 project (feeinsight-db2) after merge.

-- Institutions: a read-only copy of the institution list from today's system (DB1).
create table public.institutions (
  id                 bigint generated always as identity primary key,
  db1_institution_id bigint not null unique,
  name               text   not null,
  charter_type       text   not null check (charter_type in ('bank', 'credit_union')),
  state              text,
  website_url        text,
  total_assets_usd   numeric(18, 0),
  fdic_cert          text,
  ncua_charter       text,
  copied_at          timestamptz not null default now()
);

-- Source documents: one row per stored version of a bank's own fee document.
create table public.source_documents (
  id             bigint generated always as identity primary key,
  institution_id bigint not null references public.institutions (id),
  url            text   not null,
  fetched_at     timestamptz not null,
  content_sha256 text   not null,
  mime_type      text   not null,
  storage_path   text   not null,  -- where the original file sits in storage
  page_count     integer,
  unique (institution_id, content_sha256)
);

-- Everything in the sealed schema is read only by the scorer.
-- Reader code, prompts and tests never read it.
create schema sealed;
revoke all on schema sealed from public;
revoke all on schema sealed from anon, authenticated;

-- One answer key = one random draw of institutions.
create table sealed.key_sets (
  id         bigint generated always as identity primary key,
  name       text not null unique,          -- e.g. 'key-2026-11'
  draw_seed  text not null,                 -- seed used for the random draw, so it can be repeated
  draw_rule  text not null,                 -- plain words: population, exclusions, how many of each
  status     text not null default 'drafting'
             check (status in ('drafting', 'confirming', 'sealed', 'retired')),
  created_at timestamptz not null default now(),
  sealed_at  timestamptz
);

-- The institutions in each draw, in draw order.
create table sealed.key_institutions (
  key_set_id     bigint  not null references sealed.key_sets (id),
  institution_id bigint  not null references public.institutions (id),
  draw_rank      integer not null,
  document_id    bigint references public.source_documents (id),  -- the document the key was recorded from
  primary key (key_set_id, institution_id),
  unique (key_set_id, draw_rank)
);

-- Every fee line on the institution's own document, as recorded.
create table sealed.key_lines (
  id             bigint generated always as identity primary key,
  key_set_id     bigint not null,
  institution_id bigint not null,
  document_id    bigint not null references public.source_documents (id),
  page           integer,
  quote          text   not null,           -- the exact words from the document
  fee_name       text   not null,           -- the fee's name as the bank writes it
  category       text,                      -- Fee Insight category code
  price_kind     text   not null
                 check (price_kind in ('flat', 'rate', 'range', 'free', 'varies')),
  amount_usd     numeric(12, 2),            -- flat price, or the low end of a range
  amount_max_usd numeric(12, 2),            -- high end of a range, or a cap
  rate_pct       numeric(8, 4),             -- for prices stated as a percentage
  unit           text   not null
                 check (unit in ('per_item', 'per_day', 'per_month', 'per_quarter', 'per_year',
                                 'per_statement', 'one_time', 'per_hour', 'other')),
  conditions     text,                      -- tiers, waivers, limits, as written
  product        text,                      -- the account or product it applies to, if named
  audience       text   not null
                 check (audience in ('consumer', 'business', 'both', 'unknown')),
  recorded_by    text   not null,           -- who recorded the line (a person, or the drafting session)
  recorded_at    timestamptz not null default now(),
  foreign key (key_set_id, institution_id)
    references sealed.key_institutions (key_set_id, institution_id),
  check (price_kind <> 'flat'  or amount_usd is not null),
  check (price_kind <> 'rate'  or rate_pct is not null),
  check (price_kind <> 'range' or (amount_usd is not null and amount_max_usd is not null)),
  check (price_kind <> 'free'  or coalesce(amount_usd, 0) = 0)
);

-- A person's check of the key: agree or disagree with a recorded line,
-- or a line the recorder missed.
create table sealed.key_confirmations (
  id             bigint generated always as identity primary key,
  key_set_id     bigint not null,
  institution_id bigint not null,
  line_id        bigint references sealed.key_lines (id),
  verdict        text   not null check (verdict in ('agree', 'disagree', 'missing_line')),
  note           text,                      -- what is wrong, or the missed line as written
  confirmed_by   text   not null,           -- a person, never a model
  confirmed_at   timestamptz not null default now(),
  foreign key (key_set_id, institution_id)
    references sealed.key_institutions (key_set_id, institution_id),
  check ((verdict = 'missing_line') = (line_id is null))
);

create index key_lines_set_inst on sealed.key_lines (key_set_id, institution_id);
create index key_confirmations_set on sealed.key_confirmations (key_set_id);

-- Row level security on, with no policies: only the service role can read or write.
alter table public.institutions        enable row level security;
alter table public.source_documents    enable row level security;
alter table sealed.key_sets            enable row level security;
alter table sealed.key_institutions    enable row level security;
alter table sealed.key_lines           enable row level security;
alter table sealed.key_confirmations   enable row level security;
