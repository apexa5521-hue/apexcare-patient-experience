'use strict';

// Who can do what. Every route asks `can(user, perm)` instead of checking role names,
// so the permission table below (or its saved replacement) is the single source of truth.

const { UserError, ROLES } = require('./validate');

const ROLE_LABELS = {
  staff: 'موظف استقبال / اتصال',
  case_officer: 'موظفة المتابعة',
  quality_specialist: 'أخصائية الجودة',
  branch_manager: 'مدير فرع',
  operations: 'مدير التشغيل',
  quality: 'مدير الجودة',
  executive: 'المدير التنفيذي',
  admin: 'مدير النظام'
};

const ALL = ROLES;
const MANAGERS = ['branch_manager', 'operations', 'quality', 'admin'];
const NOT_EXEC = ALL.filter(r => r !== 'executive');
// Quality specialist: works every branch's cases and sees the analytics, but setup and approving high-severity closes stay with managers.
const QS = 'quality_specialist';

// Defaults. The admin can change who has each permission from الإدارة ← الأدوار والصلاحيات; the change is saved in
// app_settings (ROLE_PERMS_KEY) and replaces these. The system admin always keeps every permission.
const DEFAULT_PERMS = {
  record: NOT_EXEC,                                     // record experiences
  calls: NOT_EXEC,                                      // use the call list
  importCalls: [...MANAGERS, QS],
  addComplaint: NOT_EXEC,
  viewAllExperiences: [QS, 'branch_manager', 'operations', 'quality', 'executive', 'admin'],
  analytics: [QS, 'branch_manager', 'operations', 'quality', 'executive', 'admin'],
  viewCases: ['case_officer', QS, ...MANAGERS, 'executive'],
  handleCases: ['case_officer', QS, ...MANAGERS],          // contact, note, change status, close (subject to approval)
  assignCases: MANAGERS,
  editAnyExperience: [QS, ...MANAGERS],                // fix someone else's recorded experience (own ones: anyone who records)
  approveCases: MANAGERS,                               // approve closing high-severity cases
  manageSetup: ['quality', 'admin'],                    // users, doctors, categories, Google connection, roles
  fullPhones: ['case_officer', QS, ...MANAGERS]
};
/** Roles limited to one branch when the user has a branch set. */
const DEFAULT_BRANCH_SCOPED = ['branch_manager', 'case_officer'];

const PERM_LABELS = {
  record: ['تسجيل التجارب', 'تسجيل تجربة حضورية أو بالاتصال، وتعديل ما سجّله بنفسه'],
  calls: ['قائمة الاتصال', 'رؤية قائمة الاتصال وبدء التقييم بالاتصال'],
  importCalls: ['استيراد قائمة الاتصال', 'لصق زيارات اليوم من Excel'],
  addComplaint: ['إضافة شكوى', 'تسجيل شكوى يدوياً'],
  viewAllExperiences: ['رؤية كل التجارب', 'السجل كاملاً بدل تسجيلاته فقط'],
  analytics: ['المؤشرات وتقييم الطبيب', 'تبويبا مؤشرات الأداء وتقييم الطبيب'],
  viewCases: ['رؤية حالات المتابعة', 'تبويب المتابعة والشكاوى'],
  handleCases: ['معالجة الحالات', 'التواصل والتدوين والإقفال، والرد على قوقل'],
  assignCases: ['إسناد الحالات', 'تحديد المسؤول عن كل حالة'],
  editAnyExperience: ['تعديل تجارب الآخرين', 'تعديل تجربة سجّلها شخص آخر'],
  approveCases: ['اعتماد الإقفال', 'اعتماد إقفال الحالات عالية الخطورة'],
  manageSetup: ['الإدارة', 'المستخدمون والأطباء والتصنيفات وربط قوقل والصلاحيات'],
  fullPhones: ['رقم الجوال كاملاً', 'بدون هذه الصلاحية يظهر الرقم مقنّعاً']
};

const ROLE_PERMS_KEY = 'role_perms';
const clone = o => JSON.parse(JSON.stringify(o));
let PERMS = clone(DEFAULT_PERMS);
let BRANCH_SCOPED = [...DEFAULT_BRANCH_SCOPED];
let loadedAt = 0;

/** Cleans a saved table: known permissions and roles only; unknown keys fall back to the default; admin always in. */
function normalizeRolePerms(saved) {
  const perms = {};
  for (const k of Object.keys(DEFAULT_PERMS)) {
    const list = saved && saved.perms && Array.isArray(saved.perms[k]) ? saved.perms[k] : DEFAULT_PERMS[k];
    perms[k] = [...new Set([...list.filter(r => ROLES.includes(r)), 'admin'])];
  }
  const scoped = saved && Array.isArray(saved.branchScoped) ? saved.branchScoped : DEFAULT_BRANCH_SCOPED;
  return { perms, branchScoped: [...new Set(scoped.filter(r => ROLES.includes(r) && r !== 'admin'))] };
}
function applyRolePerms(saved) {
  const n = normalizeRolePerms(saved);
  PERMS = n.perms; BRANCH_SCOPED = n.branchScoped; loadedAt = Date.now();
  return n;
}
function currentRolePerms() { return { perms: clone(PERMS), branchScoped: [...BRANCH_SCOPED] }; }

/** Reads the saved table at most every `ttlMs`, so a change made on another instance is picked up soon after. */
async function refreshRolePerms(db, { ttlMs = 30000, force = false } = {}) {
  if (!force && Date.now() - loadedAt < ttlMs) return;
  try {
    const { data, error } = await db.from('app_settings').select('value').eq('key', ROLE_PERMS_KEY).maybeSingle();
    if (error) throw new Error(error.message);
    applyRolePerms(data && data.value ? JSON.parse(data.value) : null);
  } catch (e) {
    loadedAt = Date.now(); // keep what we have; try again after the TTL
    console.error('role permissions not loaded:', e.message);
  }
}

function can(user, perm) {
  if (!PERMS[perm]) throw new Error(`unknown permission ${perm}`);
  return !!user && (user.role === 'admin' || PERMS[perm].includes(user.role));
}

function requirePerm(perm) {
  return (req, _res, next) => next(can(req.user, perm) ? undefined : new UserError('لا تملك صلاحية لهذا الإجراء', 403));
}

/** The only branch this user may see, or null for all branches. */
function branchScope(user) {
  return user && BRANCH_SCOPED.includes(user.role) && user.branch ? user.branch : null;
}

/** Throws unless the user may see a record of `branch` (records with no branch are visible to everyone in scope). */
function assertBranch(user, branch) {
  const scope = branchScope(user);
  if (scope && branch && branch !== scope) throw new UserError('هذا السجل يتبع فرعاً آخر', 403);
}

function permsOf(user) {
  return Object.keys(DEFAULT_PERMS).filter(p => can(user, p));
}

module.exports = {
  ROLES, ROLE_LABELS, PERM_LABELS, DEFAULT_PERMS, DEFAULT_BRANCH_SCOPED, ROLE_PERMS_KEY,
  can, requirePerm, branchScope, assertBranch, permsOf,
  normalizeRolePerms, applyRolePerms, currentRolePerms, refreshRolePerms
};
