-- 013: phone experiences recorded straight from the form also appear in the call list, as completed calls.
-- The server does this for new ones; this fills in the ones already in the log. Safe to run more than once.

-- 1) a visit already waiting in the call list: close it with its experience
update call_queue q
set status = 'تم', experience_id = e.id, attempts = q.attempts + 1,
    last_attempt_at = e.created_at, updated_by = 'system'
from experiences e
where e.channel = 'اتصال'
  and q.status <> 'تم'
  and q.file_no = e.file_no and q.visit_at = e.visit_at
  and not exists (select 1 from call_queue c where c.experience_id = e.id);

-- 2) otherwise add it as a completed call (needs a valid mobile number and file number)
insert into call_queue (created_at, visit_at, file_no, phone, doctor_id, branch, status, attempts, last_attempt_at, experience_id, updated_by)
select e.created_at, e.visit_at, e.file_no, e.phone, e.doctor_id, e.branch, 'تم', 1, e.created_at, e.id, 'system'
from experiences e
where e.channel = 'اتصال'
  and e.phone ~ '^05[0-9]{8}$'
  and e.file_no ~ '^[A-Za-z0-9/-]{1,20}$'
  and not exists (select 1 from call_queue c where c.experience_id = e.id)
on conflict (file_no, visit_at) do nothing;

notify pgrst, 'reload schema';
