-- Run once in Supabase SQL Editor (safe to re-run).
-- Adds: management roles, follow-up cases with a timeline. Opens cases for existing
-- complaints and negative experiences.

-- Roles (widened after the first release; re-runnable).
alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (role in ('staff','case_officer','branch_manager','operations','quality','executive','admin'));

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

alter table cases enable row level security;
alter table case_events enable row level security;

-- Backfill: every complaint becomes a case (status carried over).
insert into cases (created_at, source, source_id, branch, doctor_id, file_no, phone, summary, category, severity, status, due_at, closed_at, resolution, close_reason, closed_by)
select c.created_at, 'شكوى', c.id::text, c.branch, c.doctor_id, c.file_no, c.phone, left(c.description, 2000), c.category,
       case when c.severity in ('بسيطة','متوسطة','عالية') then c.severity else 'متوسطة' end,
       case c.status when 'مغلقة' then 'مغلقة' when 'قيد المعالجة' then 'قيد المعالجة' else 'جديدة' end,
       c.created_at + case c.severity when 'عالية' then interval '24 hours' when 'متوسطة' then interval '48 hours' else interval '72 hours' end,
       c.closed_at, c.resolution, case when c.status = 'مغلقة' then 'تم الحل' end, case when c.status = 'مغلقة' then c.updated_by end
from complaints c
on conflict (source, source_id) do nothing;

-- Backfill: every negative experience becomes a case (follow-up status carried over).
insert into cases (created_at, source, source_id, branch, doctor_id, file_no, phone, summary, category, severity, status, due_at, closed_at, close_reason)
select e.created_at, 'تجربة سلبية', e.id::text, e.branch, e.doctor_id, e.file_no, e.phone,
       left(concat_ws(' — ', e.category, e.general_note), 2000), e.category, coalesce(e.severity, 'متوسطة'),
       case e.follow_up when 'مغلقة' then 'مغلقة' when 'قيد المعالجة' then 'قيد المعالجة' else 'جديدة' end,
       e.created_at + case coalesce(e.severity, 'متوسطة') when 'عالية' then interval '24 hours' when 'متوسطة' then interval '48 hours' else interval '72 hours' end,
       case when e.follow_up = 'مغلقة' then now() end, case when e.follow_up = 'مغلقة' then 'تم الحل' end
from experiences e
where e.sentiment = 'سلبية'
on conflict (source, source_id) do nothing;

-- Make the new tables visible to the API right away.
notify pgrst, 'reload schema';
