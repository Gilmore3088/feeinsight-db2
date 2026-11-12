-- 0003_standard_sources.sql
-- Step two of the plan: standardize. Every stored source document is turned into one
-- standard record of text, page by page, before any fee is read (src/rosetta/convert.ts,
-- docs/converter.md). Adds one table. No data. Applied to the DB2 project after merge.

create table public.standard_sources (
  id                  bigint generated always as identity primary key,
  source_document_id  bigint not null references public.source_documents (id),
  page                int check (page >= 1),  -- PDF page from 1; 1 for a single picture; null for a web page
  method              text not null check (method in ('pdf_text', 'html_visible', 'none')),
  text                text not null,          -- empty when method is 'none'
  alt_text            text,                   -- PDF only: the same page read without layout
  needs_image_reading boolean not null,
  converter_version   text not null,
  file_sha256         text not null,
  converted_at        timestamptz not null default now(),
  -- One row per document, page and converter version. A web page has no page number, so
  -- nulls must count as equal here, or the same web page could be stored twice.
  constraint standard_sources_one_per_page
    unique nulls not distinct (source_document_id, page, converter_version)
);

comment on table public.standard_sources is
  'The standard text of each stored source document, one row per page (one row for a web page). Written by the Rosetta converter; fees are read from here, never from the raw file.';
comment on column public.standard_sources.source_document_id is 'The stored document this text came from.';
comment on column public.standard_sources.page is 'PDF page number from 1; 1 for a single picture; null for a web page.';
comment on column public.standard_sources.method is 'How the text was taken: pdf_text (the PDF text layer), html_visible (visible text of a web page), none (no text taken).';
comment on column public.standard_sources.text is 'The page text. For a PDF, read with layout kept, so a table row stays on one line. Empty when method is none.';
comment on column public.standard_sources.alt_text is 'PDF only: the same page read without layout. The quote check tries both readings.';
comment on column public.standard_sources.needs_image_reading is 'True when the page has no text that can be trusted (scanned, drawn as shapes, a picture, too little text, or a garbled text layer) and must be read as an image.';
comment on column public.standard_sources.converter_version is 'Version of the converter that produced this row. A new version adds new rows; old rows are kept.';
comment on column public.standard_sources.file_sha256 is 'SHA-256 of the file that was converted, so the text can be tied to the exact bytes.';
comment on column public.standard_sources.converted_at is 'When this row was written.';

-- The unique constraint leads with source_document_id, so it also serves the foreign key.

-- Row level security on, with no policies: only the service role can read or write.
alter table public.standard_sources enable row level security;
