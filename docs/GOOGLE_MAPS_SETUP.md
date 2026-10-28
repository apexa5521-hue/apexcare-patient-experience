# ربط تقييمات قوقل ماب بنظام تجربة المريض (Apex Care)

> **ملاحظة لمساعد الذكاء الاصطناعي الذي يقرأ هذا الملف:**
> هذا الملف يشرح ربط تقييمات Google Maps لمجمع طبي بنظام داخلي اسمه «تجربة المريض».
> **الكود جاهز ومنشور**، والمطلوب فقط إعدادات من جهة Google وRender.
> ساعد المستخدم خطوة بخطوة بالعربي، واطلب منه لقطة شاشة عند أي خطوة غير واضحة.
> **لا تطلب منه لصق `Client Secret` أو أي كلمة سر في المحادثة.** الأسرار تُدخل مباشرة في لوحة Render.
> لا تقترح تعديل الكود ولا استخدام Places API (موضح السبب أدناه).

---

## 1) معلومات النظام

| البند | القيمة |
|---|---|
| رابط النظام | `https://apexcare-patient-experience.onrender.com` |
| الاستضافة | Render (خطة مجانية، منطقة سنغافورة)، اسم الخدمة `apexcare-patient-experience` |
| قاعدة البيانات | Supabase (مشروع مستقل) |
| الفروع | بريدة، عنيزة (غالباً كل فرع له صفحة مستقلة على قوقل) |
| رابط العودة (Redirect URI) | `https://apexcare-patient-experience.onrender.com/api/google/callback` |
| متغيرات البيئة المطلوبة في Render | `GOOGLE_CLIENT_ID` و `GOOGLE_CLIENT_SECRET` |

### الواجهة المستخدمة
**Google Business Profile API** (الواجهة الرسمية لأصحاب الأنشطة)، بصلاحية OAuth واحدة:
`https://www.googleapis.com/auth/business.manage` (وصول offline مع refresh token).

يستدعي النظام هذه العناوين:
- `https://mybusinessaccountmanagement.googleapis.com/v1/accounts`: قائمة الحسابات
- `https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations`: المواقع (الفروع)
- `https://mybusiness.googleapis.com/v4/{account}/{location}/reviews`: التقييمات والرد عليها

### لماذا ليس Places API؟
Places API تعطي 5 تقييمات فقط لكل مكان، وشروطها تمنع تخزينها أكثر من 30 يوماً. أما Business Profile API فتعطي **كل** التقييمات، وتسمح بالرد عليها، ومجانية.

### ماذا يفعل النظام بعد الربط
- يجلب كل التقييمات لكل فرع في تبويب **«تقييمات قوقل»**، ويحدّثها تلقائياً (كل 30 دقيقة كحد أقصى) أو بزر «تحديث الآن».
- تقييم **نجمة واحدة** يفتح حالة متابعة بخطورة **عالية**، و**نجمتان** بخطورة **متوسطة**.
- يمكن الرد على التقييم من داخل النظام، وينشر الرد علناً باسم المجمع.
- **لا يُحفظ اسم صاحب التقييم** (سياسة النظام: لا أسماء مرضى).

---

## 2) الخطوات

### الخطوة 1: صلاحية «مدير» على صفحة المجمع في قوقل
يقوم بها **مالك صفحة المجمع** الحالي:
1. يفتح https://business.google.com بحساب المالك.
2. لكل فرع: **⋮ (المزيد) ← إعدادات الملف التجاري (Business Profile settings) ← الأشخاص وإمكانية الوصول (People and access) ← + إضافة (Add)**.
3. يكتب بريد المستخدم، ويختار الدور **مدير (Manager)**، ثم **دعوة (Invite)**.
4. المستخدم يقبل الدعوة من بريده.

للتحقق: يفتح المستخدم https://business.google.com ببريده فيرى الفرعين.

### الخطوة 2: طلب الوصول للواجهة من قوقل (تأخذ أياماً)
1. من صفحة المتطلبات: https://developers.google.com/my-business/content/prereqs
2. تعبئة نموذج **Access request** (GBP API access request).
3. الشروط: الصفحة **موثّقة (Verified)** ونشطة منذ فترة، والبريد يملك صلاحية عليها، ورقم المشروع (Project number) من Google Cloud، وهو يُنشأ في الخطوة 3. لذلك يمكن تنفيذ الخطوة 3 أولاً ثم تعبئة النموذج.
4. الموافقة تصل بالبريد، وعادة تأخذ بضعة أيام.

### الخطوة 3: مشروع Google Cloud
1. https://console.cloud.google.com ← **New Project** ← الاسم مثلاً `apexcare-reviews`.
2. **APIs & Services ← Library**، ثم فعّل الثلاث:
   - `My Business Account Management API`
   - `My Business Business Information API`
   - `Google My Business API`
3. **OAuth consent screen** (أو Google Auth Platform ← Branding/Audience):
   - User type: **External**
   - App name: `Apex Care`، ويُكتب بريد الدعم وبريد المطوّر (بريد المستخدم)
   - **Test users**: أضف بريد المستخدم (المدير على صفحة قوقل)
   - يُترك التطبيق في وضع **Testing**؛ هذا كافٍ للاستخدام الداخلي.
4. **Credentials ← Create credentials ← OAuth client ID**:
   - Application type: **Web application**
   - **Authorized redirect URIs**: `https://apexcare-patient-experience.onrender.com/api/google/callback`
     (حرفياً، بدون شرطة `/` في النهاية)
   - Create، فيظهر **Client ID** و **Client Secret**.

### الخطوة 4: إضافة القيم في Render
1. https://dashboard.render.com ← الخدمة `apexcare-patient-experience` ← **Environment**.
2. أضف:
   - `GOOGLE_CLIENT_ID` = قيمة Client ID
   - `GOOGLE_CLIENT_SECRET` = قيمة Client Secret
3. **Save Changes**. تُعاد تشغيل الخدمة تلقائياً خلال دقيقة إلى دقيقتين.

⚠️ **لا تتعامل** مع خدمات Render الأخرى (`masar-app` و `apexcare-bot`)، فهي لأنظمة أخرى.

### الخطوة 5: الربط من داخل النظام
1. ادخل للنظام بحساب **مدير الجودة** أو **مدير النظام**.
2. تبويب **«تقييمات قوقل»** ← **«ربط حساب قوقل»**.
3. سجّل الدخول بالبريد الذي أصبح **مدير** على صفحة قوقل، ووافق على الصلاحية.
   - إذا ظهرت شاشة «Google hasn't verified this app»، اضغط **Advanced ← Go to Apex Care (unsafe)**. هذا طبيعي لأن التطبيق داخلي وفي وضع Testing.
4. يعرض النظام مواقع قوقل. اختر لكل موقع فرعه (بريدة / عنيزة) ثم **حفظ**.
5. اضغط «تحديث الآن». أول مزامنة تجلب كل التقييمات القديمة.

---

## 3) رسائل الخطأ وحلولها

| الرسالة في النظام أو قوقل | السبب | الحل |
|---|---|---|
| «قوقل لم تفعّل صلاحية Business Profile API لهذا المشروع بعد (الحصة صفر). انتظر موافقة طلب الوصول» | الخطوة 2 لم تُعتمد بعد (Quota = 0) | انتظر بريد الموافقة. لا شيء آخر مطلوب |
| «واجهات Business Profile غير مفعّلة في مشروع Google Cloud» | إحدى الواجهات الثلاث غير مفعّلة | الخطوة 3، البند 2 |
| «حساب قوقل المربوط لا يملك صلاحية إدارة هذا الموقع» | البريد ليس مديراً على الصفحة، أو الدعوة لم تُقبل | الخطوة 1، ثم «إلغاء الربط» وأعد الربط |
| «انتهت صلاحية ربط قوقل. اربطه من جديد» | سُحبت الموافقة أو تغيّرت كلمة مرور البريد | أعد الخطوة 5 |
| `Error 400: redirect_uri_mismatch` (من قوقل) | رابط العودة في Google Cloud لا يطابق | انسخه حرفياً من الجدول أعلاه |
| `Error 403: access_denied` (من قوقل) | البريد غير مضاف في Test users | الخطوة 3، البند 3 |
| «أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في إعدادات Render أولاً» | القيمتان غير موجودتين في Render | الخطوة 4 |
| لا تظهر مواقع بعد الربط | البريد لا يدير أي صفحة، أو الصفحة غير موثّقة | تحقق من business.google.com |

---

## 4) ملخص الحالة الحالية
- ✅ الكود والواجهة جاهزان ومنشوران.
- ⏳ الخطوة 1: صلاحية المدير على صفحة قوقل (لم يتأكد بعد).
- ⏳ الخطوة 2: طلب الوصول من قوقل.
- ⏳ الخطوات 3 و4 و5.
