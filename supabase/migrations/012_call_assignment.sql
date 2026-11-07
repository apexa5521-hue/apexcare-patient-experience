-- Run once in Supabase SQL Editor (safe to re-run).
-- Call list assignment: each visit to call can belong to one employee, who then sees it in her list.

alter table call_queue add column if not exists assigned_to uuid references app_users(id) on delete set null;
create index if not exists call_queue_assigned_idx on call_queue(assigned_to);

notify pgrst, 'reload schema';
