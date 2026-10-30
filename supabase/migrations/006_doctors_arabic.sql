-- Run once in Supabase SQL Editor (safe to re-run).
-- Doctors: Arabic name (so review comments in Arabic match), and sub-specialties.

alter table doctors add column if not exists name_ar text;

alter table doctors drop constraint if exists doctors_specialty_check;
alter table doctors add constraint doctors_specialty_check check (specialty in ('أسنان','جلدية','أسنان عامة','تقويم','أسنان أطفال','تركيبات','علاج عصب','جراحة الفم','زراعة'));

update doctors set name_ar='عبدالملك العايد', specialty='أسنان عامة' where name='Dr. Abdulmalik Al-Ayed';
update doctors set name_ar='عادل الحربي', specialty='تقويم' where name='Dr. Adel Al-Harbi';
update doctors set name_ar='بسام الملحم', specialty='أسنان أطفال' where name='Dr. Bassem Al-Malhem';
update doctors set name_ar='إياد الدويغري', specialty='أسنان أطفال' where name='Dr. Eyad Al-Duwighri';
update doctors set name_ar='فيصل الغدواني', specialty='أسنان عامة' where name='Dr. Faisal Al-Ghadwani';
update doctors set name_ar='محمد القرزعي' where name='Dr. Mohammed Al Qarzie';
update doctors set name_ar='محمد الباتي', specialty='أسنان عامة' where name='Dr. Mohammed Al-Bati';
update doctors set name_ar='محمد الحبيب', specialty='أسنان عامة' where name='Dr. Mohammed Al-Habib';
update doctors set name_ar='ناجي الحارثي', specialty='تركيبات' where name='Dr. Naji Al-Harthi';
update doctors set name_ar='نوف الخنيني' where name='Dr. Nouf Al Khunainy';
update doctors set name_ar='نوف الشمري', specialty='أسنان عامة' where name='Dr. Nouf Al-Shammari';
update doctors set name_ar='عمر الجاسر' where name='Dr. Omar Al Jasser';
update doctors set name_ar='عمر المطيري', specialty='أسنان عامة' where name='Dr. Omar Al-Mutairi';
update doctors set name_ar='رياض الرومي', specialty='علاج عصب' where name='Dr. Riyad Al-Roumi';
update doctors set name_ar='صالح العوفي', specialty='أسنان عامة' where name='Dr. Saleh Al-Awfi';
update doctors set name_ar='سامي الدويحي', specialty='تركيبات' where name='Dr. Sami Al-Duwaihi';
update doctors set name_ar='سلطان الخطاف', specialty='أسنان عامة' where name='Dr. Sultan Al-Khattaf';
update doctors set name_ar='تركي المطيري', specialty='جراحة الفم' where name='Dr. Turki Al-Mutairi';
update doctors set name_ar='وضاحة' where name='Dr. Wadaha';
update doctors set name_ar='زاخر الرئيس', specialty='جراحة الفم' where name='Dr. Zakher Al-Rais';
update doctors set name_ar='عبدالله الجنبي', specialty='زراعة' where name='Dr. Abdullah Janbi';
update doctors set name_ar='علي الخرس' where name='Dr. Ali Alkhars';
update doctors set name_ar='لجين' where name='Dr. Lujain';
update doctors set name_ar='ثنيان العظيب' where name='Dr. Thunayan AlOdhaib';
update doctors set name_ar='ياسر اليحيى' where name='Dr. Yasir Alyahya';

-- Doctors still without an Arabic name after this run (the English name in the database differs from the list):
select name from doctors where name_ar is null order by name;
