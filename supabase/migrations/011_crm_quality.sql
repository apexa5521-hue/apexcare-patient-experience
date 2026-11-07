-- Run once in Supabase SQL Editor (safe to re-run).
-- Stores the file-opening quality check of each CRM upload, without patient names or ID numbers.

-- File-opening quality from a CRM patient export: one row per upload. No patient names or ID numbers are kept:
-- `staff` holds per-employee counts, `errors` holds { fileNo, creator, createdAt, codes } for rows with problems.
create table if not exists crm_quality_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  uploaded_by text,
  file_name text,
  total integer not null default 0,
  complete integer not null default 0,
  period_from text,
  period_to text,
  staff jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb
);
create index if not exists crm_quality_runs_created_idx on crm_quality_runs(created_at);
alter table crm_quality_runs enable row level security;

notify pgrst, 'reload schema';
