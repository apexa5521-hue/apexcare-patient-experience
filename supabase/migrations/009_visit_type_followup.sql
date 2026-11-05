-- Run once in Supabase SQL Editor (safe to re-run).
-- Adds the visit type «متابعة» (follow-up visit) next to كشف، إجراء، كشف وإجراء.

alter table experiences drop constraint if exists experiences_visit_type_check;
alter table experiences add constraint experiences_visit_type_check check (visit_type in ('كشف','إجراء','كشف وإجراء','متابعة'));

notify pgrst, 'reload schema';
