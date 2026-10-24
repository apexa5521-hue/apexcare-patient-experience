-- Run once in Supabase SQL Editor (safe to re-run). Run 003 first.
-- Adds: service-rating QR survey responses.

-- Service-rating QR survey responses (anonymous: no name, file or phone in the form).
create table if not exists service_ratings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),   -- when the form was submitted
  source_key text unique not null,                 -- <sheetId>:<sheetName>:<row>
  branch text check (branch in ('بريدة','عنيزة')),
  visit_at timestamptz,
  q_booking smallint check (q_booking between 1 and 5),
  q_reception smallint check (q_reception between 1 and 5),
  q_waiting smallint check (q_waiting between 1 and 5),
  q_explanation smallint check (q_explanation between 1 and 5),
  q_care smallint check (q_care between 1 and 5),
  q_recommend smallint check (q_recommend between 1 and 5),
  q_overall smallint check (q_overall between 1 and 5),
  comment text check (char_length(comment) <= 2000)
);
create index if not exists service_ratings_created_idx on service_ratings(created_at);

alter table service_ratings enable row level security;
