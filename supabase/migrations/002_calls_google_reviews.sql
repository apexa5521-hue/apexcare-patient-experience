-- Run once in Supabase SQL Editor (safe to re-run).
-- Adds: survey channel (in person / phone), call list, Google reviews, settings.

alter table experiences add column if not exists channel text not null default 'حضوري' check (channel in ('حضوري','اتصال'));

-- Visits to call for a phone survey (imported from the clinic system or added by hand).
create table if not exists call_queue (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  visit_at timestamptz,
  file_no text not null check (file_no ~ '^[A-Za-z0-9/-]{1,20}$'),
  phone text not null check (phone ~ '^05[0-9]{8}$'),
  doctor_id uuid references doctors(id),
  doctor_name_raw text,
  branch text check (branch in ('بريدة','عنيزة')),
  status text not null default 'بانتظار الاتصال' check (status in ('بانتظار الاتصال','لم يرد','رفض','رقم خاطئ','تم')),
  attempts smallint not null default 0,
  last_attempt_at timestamptz,
  experience_id uuid references experiences(id),
  updated_by text
);
create index if not exists call_queue_status_idx on call_queue(status);
create unique index if not exists call_queue_visit_uniq on call_queue(file_no, visit_at);

-- Google Business Profile reviews. Reviewer names are deliberately not stored.
create table if not exists google_reviews (
  id text primary key,                 -- Google reviewId
  location text not null,              -- accounts/{a}/locations/{l}
  branch text check (branch in ('بريدة','عنيزة')),
  rating smallint check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null,
  updated_at timestamptz,
  reply text,
  replied_at timestamptz,
  status text not null default 'جديد' check (status in ('جديد','تمت المراجعة')),
  note text,
  handled_by text,
  fetched_at timestamptz not null default now()
);
create index if not exists google_reviews_created_idx on google_reviews(created_at);

-- Server-side settings (Google connection, location→branch map). Never exposed to the browser.
create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table call_queue enable row level security;
alter table google_reviews enable row level security;
alter table app_settings enable row level security;
