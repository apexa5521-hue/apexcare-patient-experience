-- Run once in Supabase SQL Editor, after 006 (safe to re-run).
-- Adds the 25 doctors with their Arabic names and specialties. A doctor already in the table keeps
-- its branch and active state; only the Arabic name and a known specialty are updated.
-- Branch is 'الكل' for new rows: set each doctor's branch from الإدارة ← الأطباء.

insert into doctors (name, name_ar, specialty, branch) values
  ('Dr. Abdulmalik Al-Ayed',  'عبدالملك العايد', 'أسنان عامة',  'الكل'),
  ('Dr. Adel Al-Harbi',       'عادل الحربي',     'تقويم',       'الكل'),
  ('Dr. Bassem Al-Malhem',    'بسام الملحم',     'أسنان أطفال', 'الكل'),
  ('Dr. Eyad Al-Duwighri',    'إياد الدويغري',   'أسنان أطفال', 'الكل'),
  ('Dr. Faisal Al-Ghadwani',  'فيصل الغدواني',   'أسنان عامة',  'الكل'),
  ('Dr. Mohammed Al Qarzie',  'محمد القرزعي',    'أسنان',       'الكل'),
  ('Dr. Mohammed Al-Bati',    'محمد الباتي',     'أسنان عامة',  'الكل'),
  ('Dr. Mohammed Al-Habib',   'محمد الحبيب',     'أسنان عامة',  'الكل'),
  ('Dr. Naji Al-Harthi',      'ناجي الحارثي',    'تركيبات',     'الكل'),
  ('Dr. Nouf Al Khunainy',    'نوف الخنيني',     'أسنان',       'الكل'),
  ('Dr. Nouf Al-Shammari',    'نوف الشمري',      'أسنان عامة',  'الكل'),
  ('Dr. Omar Al Jasser',      'عمر الجاسر',      'أسنان',       'الكل'),
  ('Dr. Omar Al-Mutairi',     'عمر المطيري',     'أسنان عامة',  'الكل'),
  ('Dr. Riyad Al-Roumi',      'رياض الرومي',     'علاج عصب',    'الكل'),
  ('Dr. Saleh Al-Awfi',       'صالح العوفي',     'أسنان عامة',  'الكل'),
  ('Dr. Sami Al-Duwaihi',     'سامي الدويحي',    'تركيبات',     'الكل'),
  ('Dr. Sultan Al-Khattaf',   'سلطان الخطاف',    'أسنان عامة',  'الكل'),
  ('Dr. Turki Al-Mutairi',    'تركي المطيري',    'جراحة الفم',  'الكل'),
  ('Dr. Wadaha',              'وضاحة',           'أسنان',       'الكل'),
  ('Dr. Zakher Al-Rais',      'زاخر الرئيس',     'جراحة الفم',  'الكل'),
  ('Dr. Abdullah Janbi',      'عبدالله الجنبي',  'زراعة',       'الكل'),
  ('Dr. Ali Alkhars',         'علي الخرس',       'أسنان',       'الكل'),
  ('Dr. Lujain',              'لجين',            'أسنان',       'الكل'),
  ('Dr. Thunayan AlOdhaib',   'ثنيان العظيب',    'أسنان',       'الكل'),
  ('Dr. Yasir Alyahya',       'ياسر اليحيى',     'أسنان',       'الكل')
on conflict (name) do update set
  name_ar = excluded.name_ar,
  specialty = case when excluded.specialty <> 'أسنان' then excluded.specialty else doctors.specialty end;

-- Should show 25 (or more, if other doctors were added before).
select count(*) as doctors, count(*) filter (where active) as active from doctors;
