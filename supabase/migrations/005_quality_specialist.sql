-- Run once in Supabase SQL Editor (safe to re-run).
-- Adds the «أخصائية الجودة» (quality specialist) role.

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (role in ('staff','case_officer','quality_specialist','branch_manager','operations','quality','executive','admin'));

notify pgrst, 'reload schema';
