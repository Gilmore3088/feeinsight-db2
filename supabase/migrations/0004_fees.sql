-- 0004_fees.sql
-- The fee record: one row per price, in the format the owner approved (docs/fee-record.md).
-- Adds one table and the trigger that blocks deletes. No data. Applied to the DB2 project
-- after merge. The same rules are mirrored in plain code in src/fees/record.ts.

create table public.fees (
  id                 bigint generated always as identity primary key,
  institution_id     bigint not null references public.institutions (id),
  source_document_id bigint not null references public.source_documents (id),
  page               int check (page >= 1),  -- PDF page from 1; null for a web page
  quote              text not null check (btrim(quote) <> ''),
  fee_name           text not null check (btrim(fee_name) <> ''),
  category           text,                   -- null = not yet sorted; the fixed list is a later piece
  price_kind         text not null check (price_kind in ('flat', 'rate', 'range', 'free', 'varies')),
  amount_usd         numeric(12, 2) check (amount_usd >= 0),
  amount_max_usd     numeric(12, 2) check (amount_max_usd >= 0),
  rate_pct           numeric(8, 4) check (rate_pct >= 0),
  unit               text not null
                     check (unit in ('per_item', 'per_day', 'per_month', 'per_quarter', 'per_year',
                                     'per_statement', 'one_time', 'per_hour', 'other')),
  conditions         text,
  product            text,
  audience           text not null check (audience in ('consumer', 'business', 'both', 'unknown')),
  document_date      text,
  read_at            timestamptz not null,
  run_id             text not null check (btrim(run_id) <> ''),
  status             text not null default 'read'
                     check (status in ('read', 'checked', 'live', 'withdrawn')),
  withdrawal_reason  text,
  quote_checked_at   timestamptz,
  quote_check_version text,
  created_at         timestamptz not null default now(),

  constraint fees_flat_needs_amount  check (price_kind <> 'flat' or amount_usd is not null),
  constraint fees_range_needs_both   check (price_kind <> 'range'
                                            or (amount_usd is not null and amount_max_usd is not null
                                                and amount_max_usd >= amount_usd)),
  constraint fees_rate_needs_rate    check (price_kind <> 'rate' or rate_pct is not null),
  constraint fees_free_is_zero       check (price_kind <> 'free' or coalesce(amount_usd, 0) = 0),
  -- A percent fee is never mixed with dollar fees: a rate row holds no dollar amounts, and
  -- every other kind holds no percent.
  constraint fees_rate_has_no_dollars check (price_kind <> 'rate'
                                             or (amount_usd is null and amount_max_usd is null)),
  constraint fees_dollars_have_no_rate check (price_kind = 'rate' or rate_pct is null),
  constraint fees_withdrawn_needs_reason check (status <> 'withdrawn'
                                                or btrim(coalesce(withdrawal_reason, '')) <> ''),
  -- Checked and live fees must have passed the plain-code quote check.
  constraint fees_checked_needs_quote_check check (status not in ('checked', 'live')
                                                   or quote_checked_at is not null),
  constraint fees_quote_check_stamp_is_whole check ((quote_checked_at is null) = (quote_check_version is null))
);

comment on table public.fees is
  'One row per price a bank or credit union charges, read from its own stored document. A fee is never deleted, only withdrawn. Format and rules: docs/fee-record.md.';
comment on column public.fees.id is 'Row id.';
comment on column public.fees.institution_id is 'The institution that charges the fee.';
comment on column public.fees.source_document_id is 'The stored document the fee was read from. No document, no fee.';
comment on column public.fees.page is 'The page of the document the quote sits on: PDF page from 1; null for a web page, which has no pages.';
comment on column public.fees.quote is 'The exact words of the document that hold the fee''s name and its price.';
comment on column public.fees.fee_name is 'The fee''s name as the bank writes it.';
comment on column public.fees.category is 'Fee Insight category, from one fixed list (a later piece). Null means not yet sorted; it is never a guess.';
comment on column public.fees.price_kind is 'How the price is stated: flat (one dollar amount), rate (a percent), range (a low and a high dollar amount), free, or varies (no amount stated).';
comment on column public.fees.amount_usd is 'Dollar amount as printed: the flat price, or the low end of a range. Null or 0 for a free fee. Always null for a rate.';
comment on column public.fees.amount_max_usd is 'High end of a range, as printed. Always null for a rate.';
comment on column public.fees.rate_pct is 'The percent as printed (1.5 means 1.5%). Set only for a rate.';
comment on column public.fees.unit is 'What the price is charged per: per_item, per_day, per_month, per_quarter, per_year, per_statement, one_time, per_hour or other.';
comment on column public.fees.conditions is 'Tiers, waivers, limits and minimums, as written. Optional.';
comment on column public.fees.product is 'The account or product the fee applies to, if the document names one. Optional.';
comment on column public.fees.audience is 'Who the fee is for: consumer, business, both or unknown.';
comment on column public.fees.document_date is 'The date printed on the document, as printed. Optional.';
comment on column public.fees.read_at is 'When the fee was read from the document.';
comment on column public.fees.run_id is 'The run that read the fee.';
comment on column public.fees.status is 'read (just read), checked (passed the quote check), live (published) or withdrawn (taken down, row kept).';
comment on column public.fees.withdrawal_reason is 'Why the fee was withdrawn. Required when status is withdrawn.';
comment on column public.fees.quote_checked_at is 'When the plain-code quote check last passed for this row. Null if it has not passed.';
comment on column public.fees.quote_check_version is 'Version of the quote check that passed (QUOTE_CHECK_VERSION in src/fees/quote-check.ts).';
comment on column public.fees.created_at is 'When this row was written.';

create index fees_institution_id on public.fees (institution_id);
create index fees_source_document_id on public.fees (source_document_id);

-- A fee is never deleted, only withdrawn.
create function public.fees_block_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'fees are withdrawn, never deleted';
end;
$$;
comment on function public.fees_block_delete() is 'Stops any delete or truncate on public.fees.';
revoke all on function public.fees_block_delete() from public, anon, authenticated;

create trigger fees_no_delete before delete on public.fees
  for each row execute function public.fees_block_delete();
create trigger fees_no_truncate before truncate on public.fees
  for each statement execute function public.fees_block_delete();

-- Row level security on, with no policies: only the service role can read or write.
alter table public.fees enable row level security;
