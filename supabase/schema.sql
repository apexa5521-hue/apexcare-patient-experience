-- Apex Care — patient experience system
-- Paste into Supabase SQL Editor and run once. Safe to re-run.
-- No patient names are stored anywhere: patients are identified by file number (+ optional phone).

create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null check (username ~ '^[a-z0-9._-]{3,30}$'),
  name text not null,
  role text not null check (role in ('staff','case_officer','quality_specialist','branch_manager','operations','quality','executive','admin')),
  branch text check (branch in ('بريدة','عنيزة')),          -- null = all branches
  password_hash text not null,
  active boolean not null default true,
  must_change boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

-- Roles (widened after the first release; re-runnable).
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (role in ('staff','case_officer','quality_specialist','branch_manager','operations','quality','executive','admin'));

create table if not exists doctors (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  name_ar text,                                              -- Arabic name, used to match review comments
  specialty text not null check (specialty in ('أسنان','جلدية','أسنان عامة','تقويم','أسنان أطفال','تركيبات','علاج عصب','جراحة الفم','زراعة')),
  branch text not null check (branch in ('بريدة','عنيزة','الكل')),
  active boolean not null default true
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  type text not null check (type in ('سلبية','إيجابية','الكل')),
  active boolean not null default true
);

create table if not exists experiences (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  visit_at timestamptz not null,
  -- Riyadh wall-clock time of the visit, used by the hour:minute filters.
  visit_time_local time generated always as ((visit_at at time zone 'Asia/Riyadh')::time) stored,
  file_no text not null check (file_no ~ '^[A-Za-z0-9/-]{1,20}$'),
  phone text check (phone is null or phone ~ '^05[0-9]{8}$'),
  doctor_id uuid not null references doctors(id),
  branch text not null check (branch in ('بريدة','عنيزة')),
  specialty text not null,
  visit_type text not null check (visit_type in ('كشف','إجراء','كشف وإجراء')),
  sentiment text not null check (sentiment in ('إيجابية','سلبية','محايدة')),
  category text,
  severity text check (severity in ('بسيطة','متوسطة','عالية')),
  follow_up text check (follow_up in ('جديدة','قيد المعالجة','مغلقة')),
  -- survey questions
  booking_rating   smallint check (booking_rating between 1 and 5),
  reception_rating smallint check (reception_rating between 1 and 5),
  plan_explained   text check (plan_explained in ('نعم','جزئياً','لا','لا ينطبق')),
  doctor_rating    smallint check (doctor_rating between 1 and 5),
  general_note text check (char_length(general_note) <= 1000),
  channel text not null default 'حضوري' check (channel in ('حضوري','اتصال')),  -- how the survey was taken
  created_by uuid not null references app_users(id)
);
-- Added after the first release; harmless when the column already exists.
alter table experiences add column if not exists channel text not null default 'حضوري' check (channel in ('حضوري','اتصال'));
create index if not exists experiences_visit_at_idx on experiences(visit_at);
create index if not exists experiences_doctor_idx on experiences(doctor_id);
create index if not exists experiences_created_by_idx on experiences(created_by);

create table if not exists complaints (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  file_no text,
  phone text,
  doctor_id uuid references doctors(id),
  doctor_name_raw text,            -- as received from the sheet if no match
  branch text,
  category text,
  severity text not null default 'متوسطة',
  status text not null default 'جديدة' check (status in ('جديدة','قيد المعالجة','مغلقة')),
  description text not null,
  source text not null,            -- 'إدخال يدوي' | 'شيت الشكاوى'
  source_key text unique,          -- idempotency key from the sheet
  assigned_to text,
  resolution text,
  closed_at timestamptz,
  updated_by text
);
create index if not exists complaints_created_at_idx on complaints(created_at);
create index if not exists complaints_status_idx on complaints(status);

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  username text,
  action text not null,
  details text
);

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

-- Follow-up cases: one per complaint, negative experience, low service rating or low Google review.
create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null check (source in ('شكوى','تجربة سلبية','تقييم خدمة','تقييم قوقل')),
  source_id text not null,
  branch text check (branch in ('بريدة','عنيزة')),
  doctor_id uuid references doctors(id),
  file_no text,
  phone text,
  summary text check (char_length(summary) <= 2000),
  category text,
  severity text not null default 'متوسطة' check (severity in ('بسيطة','متوسطة','عالية')),
  status text not null default 'جديدة' check (status in ('جديدة','قيد المعالجة','بانتظار المريض','بانتظار الاعتماد','مغلقة')),
  assigned_to uuid references app_users(id),
  due_at timestamptz,
  first_response_at timestamptz,
  close_reason text,
  resolution text check (char_length(resolution) <= 2000),
  closed_at timestamptz,
  closed_by text,
  approved_by text
);
create unique index if not exists cases_source_uniq on cases(source, source_id);
create index if not exists cases_status_idx on cases(status);
create index if not exists cases_branch_idx on cases(branch);
create index if not exists cases_assigned_idx on cases(assigned_to);
create index if not exists cases_created_idx on cases(created_at);

-- Timeline of a case: notes, contact attempts and their outcome, status changes, assignment, approval.
create table if not exists case_events (
  id bigserial primary key,
  case_id uuid not null references cases(id) on delete cascade,
  at timestamptz not null default now(),
  username text,
  type text not null check (type in ('ملاحظة','اتصال','واتساب','رسالة','حالة','إسناد','اعتماد','نظام')),
  outcome text,
  body text check (char_length(body) <= 2000)
);
create index if not exists case_events_case_idx on case_events(case_id, at);

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

-- Lock everything: only the server (service_role) can read/write.
alter table app_users  enable row level security;
alter table doctors    enable row level security;
alter table categories enable row level security;
alter table experiences enable row level security;
alter table complaints enable row level security;
alter table audit_log  enable row level security;
alter table call_queue enable row level security;
alter table google_reviews enable row level security;
alter table app_settings enable row level security;
alter table cases enable row level security;
alter table case_events enable row level security;
alter table service_ratings enable row level security;
-- No policies are created on purpose (anon/authenticated get nothing).

insert into categories (name, type) values
 ('وقت الانتظار','سلبية'),('تأخر الموعد','سلبية'),('أسلوب التعامل','سلبية'),
 ('عدم وضوح الشرح للمريض','سلبية'),('الألم أثناء الإجراء','سلبية'),('التكلفة والأسعار','سلبية'),
 ('النظافة والتعقيم','سلبية'),('نتيجة العلاج','سلبية'),('الاستقبال والحجز','سلبية'),('أخرى','الكل'),
 ('حسن التعامل','إيجابية'),('وضوح الشرح','إيجابية'),('دقة وإتقان العمل','إيجابية'),('الالتزام بالموعد','إيجابية')
on conflict (name) do nothing;
