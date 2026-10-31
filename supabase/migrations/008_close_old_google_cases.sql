-- Run once in Supabase SQL Editor (safe to re-run).
-- The first Google sync opened a case for every 1-2 star review, however old. From now on only reviews from
-- the last 30 days open a case. This closes the open cases of older reviews with the reason «تقييم قديم».
-- The reviews themselves are kept: they still count in the Google analysis (topics, people, doctors).

with old as (
  select c.id
  from cases c
  join google_reviews g on g.id = c.source_id
  where c.source = 'تقييم قوقل'
    and c.status <> 'مغلقة'
    and g.created_at < now() - interval '30 days'
), closed as (
  update cases
     set status = 'مغلقة',
         close_reason = 'تقييم قديم',
         resolution = 'أُقفلت تلقائياً: التقييم أقدم من 30 يوماً عند ربط قوقل. يبقى ضمن تحليل التقييمات.',
         closed_at = now(),
         closed_by = 'نظام',
         updated_at = now()
   where id in (select id from old)
   returning id
)
insert into case_events (case_id, username, type, body)
select id, 'نظام', 'نظام', 'أُقفلت تلقائياً: تقييم قديم (أقدم من 30 يوماً)' from closed;

-- What is left open from Google reviews (should be only the last 30 days):
select count(*) filter (where c.status <> 'مغلقة') as google_open,
       count(*) filter (where c.close_reason = 'تقييم قديم') as closed_as_old
from cases c where c.source = 'تقييم قوقل';
