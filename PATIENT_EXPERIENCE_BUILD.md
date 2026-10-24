# بناء نظام تجربة المريض — Apex Care (Supabase + Render + GitHub)

> هذا الملف هو المواصفة الكاملة للتنفيذ في Claude Code. نفّذه خطوة بخطوة، وتوقّف فقط عند الخطوات التي تحتاج حسابات المستخدم (Supabase وRender).
> لغة الواجهة: العربية (RTL). الكود والتعليقات التقنية: بالإنجليزية.

---

## 0. السياق

- الجهة: مجمع Apex Care لطب الأسنان والجلدية، فرعان: **بريدة** و**عنيزة**.
- المستخدمون: موظفو الاستقبال ومركز الاتصال (تسجيل) + الإدارة/الجودة (متابعة ومؤشرات).
- يوجد نموذج أولي يعمل على Google Apps Script (`legacy/Code.gs` و`legacy/index.html` إن وُضعا في الريبو). **انقل منه تصميم الواجهة ومنطق المؤشرات**، ولكن الخلفية الجديدة كلها Node + Supabase.
- **لا تُخزَّن أسماء المرضى إطلاقاً.** المعرّف هو رقم الملف + رقم الجوال (اختياري).

## 1. المخرجات المطلوبة

1. ريبو جديد على GitHub: `apexa5521-hue/apexcare-patient-experience` (خاص Private).
2. خادم Node (Express) يُنشر على Render ويخدم الـ API والواجهة على نفس الرابط.
3. قاعدة بيانات Supabase (Postgres) مع ملف `supabase/schema.sql` جاهز للصق في SQL Editor.
4. سكربت Apps Script صغير `integrations/complaints-sheet/Code.gs` يرسل كل شكوى جديدة من شيت الشكاوى إلى الخادم.
5. ملف `render.yaml` للنشر عبر Blueprint، و`README.md` بالعربية فيه خطوات التشغيل.

## 2. هيكل الريبو

```
apexcare-patient-experience/
├─ server/
│  ├─ index.js            # Express app, static hosting, routes mount
│  ├─ db.js               # Supabase client (service role)
│  ├─ auth.js             # bcrypt, JWT, middleware, login rate-limit
│  ├─ validate.js         # zod schemas + phone/fileNo normalizers
│  ├─ routes/
│  │  ├─ auth.js          # login, me, change-password, logout
│  │  ├─ lookups.js
│  │  ├─ experiences.js
│  │  ├─ complaints.js    # + /api/webhooks/complaints
│  │  ├─ kpis.js
│  │  └─ admin.js         # users, doctors, categories
│  ├─ kpis.js             # aggregation logic (pure functions, unit-tested)
│  └─ seed-admin.js       # one-off: creates first admin, prints temp password
├─ public/
│  └─ index.html          # single-file RTL UI (vanilla JS, no build step)
├─ supabase/schema.sql
├─ integrations/complaints-sheet/Code.gs
├─ test/                  # node:test unit + API tests
├─ render.yaml
├─ .env.example
├─ package.json
└─ README.md
```

التبعيات: `express`, `@supabase/supabase-js`, `bcryptjs`, `jsonwebtoken`, `zod`, `helmet`, `express-rate-limit`, `dotenv`. Node 20+. بدون أي إطار واجهة وبدون خطوة build.

## 3. قاعدة البيانات — `supabase/schema.sql`

اكتب الملف كاملاً بحيث يُشغَّل مرة واحدة دون أخطاء (`create ... if not exists`).

```sql
create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null check (username ~ '^[a-z0-9._-]{3,30}$'),
  name text not null,
  role text not null check (role in ('staff','admin')),
  branch text check (branch in ('بريدة','عنيزة')),          -- null = all branches
  password_hash text not null,
  active boolean not null default true,
  must_change boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

create table if not exists doctors (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  specialty text not null check (specialty in ('أسنان','جلدية')),
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
  -- new survey questions
  booking_rating   smallint check (booking_rating between 1 and 5),
  reception_rating smallint check (reception_rating between 1 and 5),
  plan_explained   text check (plan_explained in ('نعم','جزئياً','لا','لا ينطبق')),
  doctor_rating    smallint check (doctor_rating between 1 and 5),
  general_note text check (char_length(general_note) <= 1000),
  created_by uuid not null references app_users(id)
);
create index if not exists experiences_visit_at_idx on experiences(visit_at);
create index if not exists experiences_doctor_idx on experiences(doctor_id);

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

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  username text,
  action text not null,
  details text
);

-- Lock everything: only the server (service_role) can read/write.
alter table app_users  enable row level security;
alter table doctors    enable row level security;
alter table categories enable row level security;
alter table experiences enable row level security;
alter table complaints enable row level security;
alter table audit_log  enable row level security;
-- No policies are created on purpose (anon/authenticated get nothing).

insert into categories (name, type) values
 ('وقت الانتظار','سلبية'),('تأخر الموعد','سلبية'),('أسلوب التعامل','سلبية'),
 ('عدم وضوح الشرح للمريض','سلبية'),('الألم أثناء الإجراء','سلبية'),('التكلفة والأسعار','سلبية'),
 ('النظافة والتعقيم','سلبية'),('نتيجة العلاج','سلبية'),('الاستقبال والحجز','سلبية'),('أخرى','الكل'),
 ('حسن التعامل','إيجابية'),('وضوح الشرح','إيجابية'),('دقة وإتقان العمل','إيجابية'),('الالتزام بالموعد','إيجابية')
on conflict (name) do nothing;
```

## 4. متغيرات البيئة — `.env.example`

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
JWT_SECRET=                 # long random string
WEBHOOK_SECRET=             # shared with the complaints-sheet Apps Script
TZ_NAME=Asia/Riyadh
OVERDUE_DAYS=3
PORT=3000
```

مفتاح `service_role` يبقى في الخادم فقط، ولا يظهر في الواجهة أبداً.

## 5. المصادقة والصلاحيات

- الدخول باسم مستخدم + كلمة مرور (لا بريد إلكتروني). تشفير `bcryptjs` بتكلفة 12.
- JWT صالح 8 ساعات، يُرسل في `Authorization: Bearer`. يُحفظ في `sessionStorage` في الواجهة.
- `must_change = true` → كل الطلبات مرفوضة (403) ما عدا `me` و`change-password` و`logout`.
- حد المحاولات: 5 محاولات فاشلة لكل اسم مستخدم خلال 10 دقائق (في الذاكرة يكفي) + `express-rate-limit` عام على `/api/auth/login`.
- **الموظف (staff):** يسجّل التجارب، يرى تجاربه فقط، يرى الشكاوى ويضيف شكوى، والجوالات تظهر له مقنّعة `05*****123`. لا يعدّل شكوى ولا يرى المؤشرات أو الإدارة.
- **الإدارة (admin):** كل شيء، والجوالات كاملة.
- الإقناع (masking) يتم في الخادم، لا في الواجهة.
- سجّل في `audit_log`: الدخول (الناجح والفاشل)، وكل إضافة أو تعديل.
- `node server/seed-admin.js` ينشئ حساب `admin` بكلمة مرور مؤقتة عشوائية (10 خانات) ويطبعها مرة واحدة في الطرفية، مع `must_change = true`. لا ينشئه إذا كان موجوداً.

## 6. الـ API

كل الردود JSON بالشكل `{ ok: true, ... }` أو `{ ok: false, error: "رسالة عربية واضحة" }`. لا تُرجِع تفاصيل الأخطاء الداخلية للمستخدم.

| Method | Path | Role | الوصف |
|---|---|---|---|
| POST | `/api/auth/login` | — | دخول |
| GET | `/api/auth/me` | any | المستخدم الحالي |
| POST | `/api/auth/change-password` | any | ≥ 8 أحرف ومختلفة عن الحالية |
| GET | `/api/lookups` | any | الأطباء والتصنيفات النشطة + القوائم الثابتة |
| POST | `/api/experiences` | any | تسجيل تجربة |
| GET | `/api/experiences` | any | قائمة مع فلاتر (staff: سجلاته فقط)، حد 500 + العدد الكلي |
| PATCH | `/api/experiences/:id/follow-up` | admin | للتجارب السلبية فقط |
| GET | `/api/complaints` | any | قائمة + ملخص (الكل / مفتوحة / متأخرة) |
| POST | `/api/complaints` | any | شكوى يدوية |
| PATCH | `/api/complaints/:id` | admin | الحالة، المسؤول، الحل. `closed_at` يُضبط عند الإغلاق ويُمسح عند إعادة الفتح |
| POST | `/api/webhooks/complaints` | header `X-Webhook-Secret` | استقبال شكاوى الشيت (انظر §9) |
| GET | `/api/kpis` | admin | المؤشرات (انظر §8) |
| GET/POST/PATCH | `/api/admin/users` | admin | إنشاء يُرجِع كلمة مرور مؤقتة مرة واحدة، وإعادة تعيين كذلك. لا يستطيع المدير تعطيل نفسه أو تخفيض صلاحيته |
| GET/POST/PATCH | `/api/admin/doctors` | admin | إضافة، تعديل، تفعيل/تعطيل (لا حذف) |
| GET/POST/PATCH | `/api/admin/categories` | admin | نفس الشيء |
| GET | `/api/health` | — | للتحقق من Render |

**الفلاتر المشتركة:** `from`, `to` (تاريخ)، `timeFrom`, `timeTo` (ساعة:دقيقة)، `branch`, `doctorId`, `sentiment`, `visitType`, `status`, `fileNo` (بحث جزئي). كل التواريخ والساعات تُفسَّر بتوقيت `Asia/Riyadh`.

**التحقق (zod) عند تسجيل تجربة:**
- رقم الملف إجباري، أحرف إنجليزية وأرقام و`/-` حتى 20 خانة.
- الجوال اختياري، يُوحَّد إلى `05XXXXXXXX` (يقبل `+966` و`00966` و`5XXXXXXXX`).
- الطبيب يجب أن يكون نشطاً، والتخصص يُؤخذ من سجل الطبيب لا من الطلب.
- التجربة سلبية ← التصنيف والخطورة إجباريان، و`follow_up = 'جديدة'`.
- الأسئلة الأربعة الجديدة **إجبارية** (أو `لا ينطبق` لسؤال الخطة العلاجية عند الكشف فقط)، والملاحظة العامة اختيارية.

## 7. الواجهة — `public/index.html`

ملف واحد (HTML + CSS + JS)، RTL، خط IBM Plex Sans Arabic، يعمل على الجوال (عرض 390px) بدون تمرير أفقي. انقل التصميم من `legacy/index.html` إن وُجد. يستدعي الـ API بمسارات نسبية (`/api/...`).

**التبويبات:** تسجيل تجربة · السجل · الشكاوى (مع شارة بعدد المفتوحة) · مؤشرات الأداء (admin) · الإدارة (admin).

**نموذج تسجيل التجربة بالترتيب:**
1. رقم الملف* · رقم الجوال · الفرع* (يُعبّأ تلقائياً من فرع الموظف)
2. الطبيب* (يتصفّى حسب الفرع) · تاريخ الزيارة* · الوقت* (الافتراضي: الآن)
3. نوع الزيارة*: كشف / إجراء / كشف وإجراء (أزرار مقسّمة)
4. **قسم «تقييم الزيارة»** (جديد):
   - كيف كان أداء موظف الحجز؟* — 5 نجوم
   - كيف كان أداء موظف الاستقبال؟* — 5 نجوم
   - هل شُرحت لك الخطة العلاجية بوضوح؟* — نعم / جزئياً / لا (+ «لا ينطبق» يظهر فقط عند نوع الزيارة «كشف»)
   - كيف كان أداء الطبيب معك؟* — 5 نجوم
   - النجوم: أزرار كبيرة قابلة للمس (≥ 44px)، تعمل بلوحة المفاتيح، مع نص تحت التقييم (1 ضعيف جداً … 5 ممتاز).
5. التجربة العامة*: إيجابية / سلبية / محايدة
   - سلبية ← تصنيف المشكلة* + درجة الخطورة*
   - إيجابية ← نوع الإشادة (اختياري)
6. **هل لديك ملاحظة عامة؟** — نص حر حتى 1000 حرف، مع تنبيه «بدون اسم المريض»
7. زر حفظ ← رسالة نجاح، تفريغ النموذج مع إبقاء الفرع، والتركيز على رقم الملف.

**السجل:** جدول بالأعمدة السابقة + أعمدة التقييمات الأربعة ووضوح الخطة. فلاتر + فترة سريعة (هذا الشهر / الشهر الماضي / آخر 3 أشهر / هذه السنة) + تصدير CSV (UTF-8 BOM ليُفتح بالعربية في Excel). للإدارة: قائمة منسدلة لتحديث حالة متابعة السلبيات.

**الشكاوى:** بطاقات (الإجمالي، المفتوحة، المتأخرة > `OVERDUE_DAYS`)، جدول مع إبراز المتأخر، نافذة «شكوى جديدة»، نافذة «معالجة» للإدارة، تصدير CSV.

**الإدارة:** المستخدمون (إنشاء/تعديل/تعطيل/إعادة تعيين كلمة المرور وعرض المؤقتة مرة واحدة)، الأطباء، التصنيفات.

**عام:** هروب كل النصوص قبل إدخالها في HTML (`esc`)، رسائل الأخطاء بالعربية، حالة تحميل على الأزرار، ورسالة واضحة عند انتهاء الجلسة تعيد لشاشة الدخول.

## 8. المؤشرات — `GET /api/kpis`

احسبها في `server/kpis.js` كدوال نقية (تُختبر بوحدات) على البيانات المفلترة، بتوقيت الرياض.

- **ملخص:** إجمالي التجارب، % إيجابية/سلبية/محايدة، متوسط تقييم الحجز، متوسط تقييم الاستقبال، متوسط تقييم الأطباء، % «نعم» لوضوح الخطة (من غير «لا ينطبق»)، عدد الشكاوى، المفتوحة، المتأخرة، متوسط ساعات الإغلاق.
- **لكل طبيب:** عدد التجارب، % إيجابي/محايد/سلبي، صافي التجربة = (إيجابي − سلبي) ÷ الإجمالي × 100، **متوسط تقييم الطبيب**، **% وضوح الخطة العلاجية**، السلبيات عالية الخطورة، عدد الشكاوى، متوسط زمن الإغلاق. علامة «عينة صغيرة» إذا كان العدد < 20. الترتيب حسب صافي التجربة.
- **لكل فرع:** متوسط تقييم الحجز، متوسط تقييم الاستقبال، متوسط تقييم الأطباء، % وضوح الخطة، عدد التجارب.
- **توزيع التقييمات:** عدد كل نجمة (1–5) لكل سؤال من الأسئلة الثلاثة.
- **أكثر المشاكل تكراراً:** أعلى 10 تصنيفات (من التجارب السلبية + الشكاوى، كلٌّ على حدة).
- **التوزيع الزمني:** حسب الساعة (0–23)، يوم الأسبوع، الشهر (`YYYY-MM`)، السنة. لكل نقطة: الإجمالي، السلبي، ومتوسط تقييم الطبيب.
- **خريطة حرارية:** 7 أيام × 24 ساعة لعدد التجارب السلبية.
- **اتجاه شهري للتقييمات:** متوسط الحجز/الاستقبال/الطبيب لكل شهر (خط بسيط).

في الواجهة: بطاقات أرقام، جدول الأطباء، جدول الفروع، أعمدة بسيطة بـ CSS (لا مكتبات رسم)، والخريطة الحرارية. لون واحد للسلبي، ولون محايد للباقي، والأرقام بخط `tabular-nums`.

## 9. ربط شيت الشكاوى — `integrations/complaints-sheet/Code.gs`

سكربت يُلصق في شيت الشكاوى (الإضافات ← Apps Script):

- `setup()`: يحفظ `WEBHOOK_URL` و`WEBHOOK_SECRET` في Script Properties (يطلبهما بـ prompt)، وينشئ مشغّل `onFormSubmit` إذا كان الشيت مربوطاً بنموذج، **وأيضاً** مشغّلاً زمنياً كل 15 دقيقة كاحتياط.
- `pushNew()`: يقرأ الصفوف، ويحدد الأعمدة بأسمائها (عربي/إنجليزي):
  - رقم الملف: `رقم الملف`, `رقم ملف المريض`, `file`, `file no`, `mrn`
  - الجوال: `الجوال`, `رقم الجوال`, `phone`, `mobile`
  - الطبيب: `الطبيب`, `اسم الطبيب`, `doctor`
  - الفرع: `الفرع`, `branch`
  - التصنيف: `التصنيف`, `نوع الشكوى`, `category`
  - الخطورة: `الخطورة`, `درجة الخطورة`, `severity`
  - النص: `الشكوى`, `تفاصيل الشكوى`, `نص الشكوى`, `الوصف`, `complaint`, `description`
  - التاريخ: `التاريخ`, `تاريخ الشكوى`, `الطابع الزمني`, `timestamp`, `date`
- **أي عمود فيه اسم المريض لا يُرسل أبداً.** يُرسل فقط الحقول أعلاه.
- يرسل دفعات (حتى 50) إلى `/api/webhooks/complaints` مع `X-Webhook-Secret`. لكل صف `source_key = <sheetId>:<sheetName>:<row>`.
- يحفظ آخر صف أُرسل بنجاح في Script Properties، ولا يتقدم إذا فشل الطلب.
- الخادم: `upsert` على `source_key` (لا تكرار)، يطابق اسم الطبيب مع جدول `doctors`، وإن لم يجده يحفظه في `doctor_name_raw`، ويوحّد الجوال (وإن كان غير صالح يتركه فارغاً).

## 10. النشر

**`render.yaml`:**
```yaml
services:
  - type: web
    name: apexcare-patient-experience
    runtime: node
    plan: starter            # free sleeps when idle; starter recommended for daily clinic use
    region: frankfurt
    buildCommand: npm ci
    startCommand: node server/index.js
    healthCheckPath: /api/health
    envVars:
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: JWT_SECRET
        generateValue: true
      - key: WEBHOOK_SECRET
        generateValue: true
      - key: TZ_NAME
        value: Asia/Riyadh
      - key: OVERDUE_DAYS
        value: "3"
```

**`server/index.js`:** `helmet` (مع CSP تسمح بـ Google Fonts فقط)، `express.json({ limit: '200kb' })`، `trust proxy`، يخدم `public/` ويعيد `index.html` لأي مسار غير `/api`.

## 11. الاختبارات (قبل الرفع)

باستخدام `node:test` + Supabase وهمي (mock للعميل) أو قاعدة Postgres محلية إن توفرت:

1. توحيد الجوال ورفض رقم الملف غير الصالح.
2. تجربة سلبية بدون تصنيف ← مرفوضة. الأسئلة الأربعة ناقصة ← مرفوضة.
3. «لا ينطبق» مرفوضة إذا كان نوع الزيارة ليس «كشف».
4. الموظف لا يرى إلا تجاربه، والجوال مقنّع، و`/api/kpis` يرجع 403.
5. `must_change` يمنع كل شيء ما عدا تغيير كلمة المرور.
6. Webhook بسر خاطئ ← 401. نفس `source_key` مرتين ← سجل واحد. عمود اسم المريض لا يُحفظ.
7. `kpis.js`: صافي التجربة، المتوسطات، استبعاد «لا ينطبق» من نسبة وضوح الخطة، والتجميع بتوقيت الرياض (زيارة 23:30 الرياض تقع في نفس اليوم، لا اليوم التالي).
8. اختبار متصفح (Playwright) على الجوال وسطح المكتب: دخول ← تغيير كلمة المرور ← تسجيل تجربة كاملة ← ظهورها في السجل ← ظهورها في المؤشرات. خذ لقطات شاشة وراجعها.

## 12. الرفع إلى GitHub

1. أنشئ الريبو `apexa5521-hue/apexcare-patient-experience` (Private) إن لم يكن موجوداً.
2. `.gitignore`: `node_modules`, `.env`, لقطات الاختبار.
3. تأكد أن لا مفاتيح أو كلمات مرور في أي ملف (`git grep -i "service_role\|eyJ"`).
4. Commit واحد واضح: `Initial patient experience system (Supabase + Render)` ثم Push إلى `main`.

## 13. ما يفعله المستخدم بعد الرفع (اكتبه في README بالعربية)

1. **Supabase:** أنشئ مشروعاً (اختر أقرب منطقة متاحة) ← SQL Editor ← الصق `supabase/schema.sql` ← Run. من Project Settings ← API انسخ `Project URL` و`service_role key`.
2. **Render:** New ← Blueprint ← اختر الريبو ← ضع `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` ← Deploy.
3. من Render ← Shell شغّل: `node server/seed-admin.js` واحفظ كلمة المرور المؤقتة.
4. افتح رابط Render ← ادخل بـ `admin` ← غيّر كلمة المرور ← أضف الأطباء والموظفين.
5. **شيت الشكاوى:** الصق `integrations/complaints-sheet/Code.gs` ← شغّل `setup` ← أدخل رابط Render + `/api/webhooks/complaints` وقيمة `WEBHOOK_SECRET` من Render.
6. أضف رابط النظام في البوابة الموحدة.

## 14. معايير القبول

- [ ] النموذج يحتوي الأسئلة الخمسة الجديدة بالترتيب، ويعمل باللمس على الجوال.
- [ ] لا يوجد أي حقل أو عمود لاسم المريض في الواجهة أو قاعدة البيانات أو الـ webhook.
- [ ] RLS مفعّل على كل الجداول، ومفتاح `service_role` غير موجود في `public/`.
- [ ] المؤشرات تعرض تقييم كل طبيب ووضوح الخطة، وتقييم الحجز والاستقبال لكل فرع، وتعمل كل الفلاتر بالساعة والدقيقة.
- [ ] كل الاختبارات تنجح، ولقطات الشاشة سليمة على 390px و1280px.
- [ ] الكود مرفوع على `main`، و`README.md` فيه خطوات §13.

عند الانتهاء: اعرض ملخصاً قصيراً بما بُني، ونتائج الاختبارات، وأي شيء لم يُنفذ وسببه.
