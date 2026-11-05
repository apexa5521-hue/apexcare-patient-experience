-- Run once in Supabase SQL Editor (safe to re-run).
-- Clinics and laser devices, chosen in the experience form next to the doctors.
-- Branch 'الكل': change it from الإدارة ← الأطباء if one works in a single branch.

insert into doctors (name, name_ar, specialty, branch) values
  ('ليزر كلاريتي',          'ليزر كلاريتي',          'جلدية', 'الكل'),
  ('ليزر جنتل',             'ليزر جنتل',             'جلدية', 'الكل'),
  ('عيادة جلدية - د.وضاحة', 'عيادة جلدية - د.وضاحة', 'جلدية', 'الكل'),
  ('عيادة بشرة',            'عيادة بشرة',            'جلدية', 'الكل')
on conflict (name) do nothing;

select name, specialty, branch, active from doctors where specialty = 'جلدية' order by name;
