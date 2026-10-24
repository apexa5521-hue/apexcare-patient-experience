'use strict';

const { z } = require('zod');

const BRANCHES = ['بريدة', 'عنيزة'];
const SPECIALTIES = ['أسنان', 'جلدية'];
const VISIT_TYPES = ['كشف', 'إجراء', 'كشف وإجراء'];
const SENTIMENTS = ['إيجابية', 'سلبية', 'محايدة'];
const SEVERITIES = ['بسيطة', 'متوسطة', 'عالية'];
const STATUSES = ['جديدة', 'قيد المعالجة', 'مغلقة'];
const PLAN_ANSWERS = ['نعم', 'جزئياً', 'لا', 'لا ينطبق'];
const CATEGORY_TYPES = ['سلبية', 'إيجابية', 'الكل'];
const ROLES = ['staff', 'admin'];
const NOT_APPLICABLE = 'لا ينطبق';
const CHANNELS = ['حضوري', 'اتصال'];
const CALL_STATUSES = ['بانتظار الاتصال', 'لم يرد', 'رفض', 'رقم خاطئ', 'تم'];
// Outcomes a caller can record without a survey; "تم" is set only by saving the survey.
const CALL_OUTCOMES = ['لم يرد', 'رفض', 'رقم خاطئ', 'بانتظار الاتصال'];

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.userMessage = true;
  }
}

const FILE_NO_RE = /^[A-Za-z0-9/-]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Arabic-Indic and Persian digits typed on phone keyboards → ASCII.
function asciiDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, c => c.charCodeAt(0) - 0x06f0);
}

/** Normalize a Saudi mobile to 05XXXXXXXX. Returns null for empty, throws for invalid. */
function normalizePhone(v) {
  let s = asciiDigits(v).replace(/[\s\-()]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('966')) s = s.slice(3);
  if (!s.startsWith('0')) s = '0' + s;
  if (!/^05\d{8}$/.test(s)) throw new UserError('رقم الجوال غير صالح (مثال: 05XXXXXXXX)');
  return s;
}

/** Like normalizePhone but never throws (used for sheet imports). */
function tryPhone(v) {
  try { return normalizePhone(v); } catch { return null; }
}

/** Branch from free text in Arabic or English ("فرع بريدة", "Buraydah", "UNAIZAH"…); null if unrecognised. */
function normalizeBranch(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه');
  if (!s) return null;
  if (/بريد|bura[iy]?d|buraid|braid/.test(s)) return 'بريدة';
  if (/عنيز|[ou]na[iy]?z|[ou]nayz|anaiz/.test(s)) return 'عنيزة';
  return null;
}

function normalizeFileNo(v) {
  const s = asciiDigits(v).trim();
  if (!FILE_NO_RE.test(s)) throw new UserError('رقم الملف غير صالح (أرقام وحروف إنجليزية و / - فقط، حتى 20 خانة)');
  return s;
}

function maskPhone(p) {
  return p && p.length >= 6 ? p.slice(0, 2) + '*****' + p.slice(-3) : (p || '');
}

const trimmed = (max) => z.string().trim().max(max);
const optText = (max) => z.preprocess(v => (v === null || v === undefined ? '' : v), trimmed(max)).transform(v => v || null);
const oneOf = (list, label) => z.string({ error: `اختر ${label}` }).refine(v => list.includes(v), { message: `قيمة غير صالحة: ${label}` });
const rating = (label) => z.coerce.number({ error: `قيّم ${label}` }).int().min(1, `قيّم ${label}`).max(5, `قيّم ${label}`);

const experienceSchema = z.object({
  fileNo: z.string({ error: 'رقم الملف مطلوب' }),
  phone: z.any().optional(),
  branch: oneOf(BRANCHES, 'الفرع'),
  doctorId: z.string({ error: 'اختر الطبيب' }).regex(UUID_RE, 'اختر الطبيب من القائمة'),
  visitDate: z.string({ error: 'تاريخ الزيارة مطلوب' }).regex(DATE_RE, 'تاريخ الزيارة غير صالح'),
  visitTime: z.string({ error: 'وقت الزيارة مطلوب' }).regex(TIME_RE, 'وقت الزيارة غير صالح'),
  visitType: oneOf(VISIT_TYPES, 'نوع الزيارة'),
  bookingRating: rating('أداء موظف الحجز'),
  receptionRating: rating('أداء موظف الاستقبال'),
  planExplained: oneOf(PLAN_ANSWERS, 'إجابة سؤال الخطة العلاجية'),
  doctorRating: rating('أداء الطبيب'),
  sentiment: oneOf(SENTIMENTS, 'التجربة العامة'),
  category: optText(80),
  severity: z.any().optional(),
  generalNote: optText(1000),
  channel: z.preprocess(v => v || 'حضوري', oneOf(CHANNELS, 'طريقة التقييم')),
  callId: z.preprocess(v => v || null, z.string().regex(UUID_RE, 'سجل الاتصال غير موجود').nullable())
}).superRefine((d, ctx) => {
  if (d.planExplained === NOT_APPLICABLE && d.visitType !== 'كشف') {
    ctx.addIssue({ code: 'custom', message: '«لا ينطبق» متاحة لزيارات الكشف فقط' });
  }
  if (d.sentiment === 'سلبية') {
    if (!d.category) ctx.addIssue({ code: 'custom', message: 'اختر تصنيف المشكلة للتجربة السلبية' });
    if (!SEVERITIES.includes(d.severity)) ctx.addIssue({ code: 'custom', message: 'اختر درجة الخطورة للتجربة السلبية' });
  }
});

const complaintSchema = z.object({
  fileNo: z.string({ error: 'رقم الملف مطلوب' }),
  phone: z.any().optional(),
  branch: oneOf(BRANCHES, 'الفرع'),
  doctorId: z.preprocess(v => v || null, z.string().regex(UUID_RE, 'الطبيب غير موجود في القائمة').nullable()),
  category: optText(80),
  severity: z.preprocess(v => v || 'متوسطة', oneOf(SEVERITIES, 'درجة الخطورة')),
  description: z.string({ error: 'اكتب تفاصيل الشكوى' }).trim().min(1, 'اكتب تفاصيل الشكوى').max(2000, 'تفاصيل الشكوى طويلة (الحد 2000 حرف)')
});

const complaintUpdateSchema = z.object({
  status: oneOf(STATUSES, 'الحالة'),
  assignedTo: optText(80),
  resolution: optText(1000),
  // Optional: lets admins complete sheet complaints that arrived without a branch or doctor.
  branch: z.preprocess(v => (v === '' ? null : v), oneOf(BRANCHES, 'الفرع').nullable().optional()),
  doctorId: z.preprocess(v => (v === '' ? null : v), z.string().regex(UUID_RE, 'الطبيب غير موجود في القائمة').nullable().optional())
});

const followUpSchema = z.object({ followUp: oneOf(STATUSES, 'الحالة') });

const userCreateSchema = z.object({
  username: z.string({ error: 'اسم المستخدم مطلوب' }).trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'اسم المستخدم: 3-30 حرفاً إنجليزياً صغيراً أو أرقاماً أو . _ -'),
  name: z.string({ error: 'أدخل الاسم' }).trim().min(1, 'أدخل الاسم').max(80),
  role: oneOf(ROLES, 'الدور'),
  branch: z.preprocess(v => v || null, oneOf(BRANCHES, 'الفرع').nullable())
});

const userUpdateSchema = z.object({
  name: z.string().trim().min(1, 'أدخل الاسم').max(80).optional(),
  role: oneOf(ROLES, 'الدور').optional(),
  branch: z.preprocess(v => (v === '' ? null : v), oneOf(BRANCHES, 'الفرع').nullable().optional()),
  active: z.boolean().optional(),
  resetPassword: z.boolean().optional()
});

const doctorSchema = z.object({
  name: z.string({ error: 'أدخل اسم الطبيب' }).trim().min(1, 'أدخل اسم الطبيب').max(80),
  specialty: oneOf(SPECIALTIES, 'التخصص'),
  branch: oneOf([...BRANCHES, 'الكل'], 'الفرع'),
  active: z.boolean().optional()
});

const categorySchema = z.object({
  name: z.string({ error: 'أدخل اسم التصنيف' }).trim().min(1, 'أدخل اسم التصنيف').max(80),
  type: oneOf(CATEGORY_TYPES, 'النوع'),
  active: z.boolean().optional()
});

const passwordChangeSchema = z.object({
  oldPassword: z.string({ error: 'أدخل كلمة المرور الحالية' }).min(1, 'أدخل كلمة المرور الحالية'),
  newPassword: z.string({ error: 'أدخل كلمة المرور الجديدة' }).min(8, 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف').max(128)
});

/** Parse with a zod schema; throw the first Arabic message as a UserError. */
function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new UserError(r.error.issues[0]?.message || 'بيانات غير صالحة');
  return r.data;
}

/** Shared list filters from a query string. Invalid values are rejected, empty ones ignored. */
function parseFilters(q = {}) {
  const f = {};
  const pick = (k) => (typeof q[k] === 'string' && q[k].trim() ? q[k].trim() : null);
  for (const k of ['from', 'to']) {
    const v = pick(k);
    if (v) { if (!DATE_RE.test(v)) throw new UserError('صيغة التاريخ غير صالحة'); f[k] = v; }
  }
  for (const k of ['timeFrom', 'timeTo']) {
    const v = pick(k);
    if (v) { if (!TIME_RE.test(v)) throw new UserError('صيغة الوقت غير صالحة'); f[k] = v; }
  }
  const lists = { branch: BRANCHES, sentiment: SENTIMENTS, visitType: VISIT_TYPES, status: STATUSES, channel: CHANNELS };
  for (const [k, list] of Object.entries(lists)) {
    const v = pick(k);
    if (v) { if (!list.includes(v)) throw new UserError('قيمة فلتر غير صالحة'); f[k] = v; }
  }
  const doc = pick('doctorId');
  if (doc) { if (!UUID_RE.test(doc)) throw new UserError('قيمة فلتر غير صالحة'); f.doctorId = doc; }
  const file = pick('fileNo');
  if (file) f.fileNo = asciiDigits(file).replace(/[^A-Za-z0-9/-]/g, '').slice(0, 20);
  return f;
}

module.exports = {
  BRANCHES, SPECIALTIES, VISIT_TYPES, SENTIMENTS, SEVERITIES, STATUSES, PLAN_ANSWERS, CATEGORY_TYPES, ROLES, NOT_APPLICABLE,
  CHANNELS, CALL_STATUSES, CALL_OUTCOMES,
  UUID_RE, UserError, normalizePhone, tryPhone, normalizeFileNo, normalizeBranch, maskPhone, parse, parseFilters,
  experienceSchema, complaintSchema, complaintUpdateSchema, followUpSchema,
  userCreateSchema, userUpdateSchema, doctorSchema, categorySchema, passwordChangeSchema
};
