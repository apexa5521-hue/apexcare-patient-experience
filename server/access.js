'use strict';

// Who can do what. Every route asks `can(user, perm)` instead of checking role names,
// so the permission table below is the single source of truth.

const { UserError, ROLES } = require('./validate');

const ROLE_LABELS = {
  staff: 'موظف استقبال / اتصال',
  case_officer: 'موظفة المتابعة',
  branch_manager: 'مدير فرع',
  operations: 'مدير التشغيل',
  quality: 'مدير الجودة',
  executive: 'المدير التنفيذي',
  admin: 'مدير النظام'
};

const ALL = ROLES;
const MANAGERS = ['branch_manager', 'operations', 'quality', 'admin'];
const NOT_EXEC = ALL.filter(r => r !== 'executive');

const PERMS = {
  record: NOT_EXEC,                                     // record experiences
  calls: NOT_EXEC,                                      // use the call list
  importCalls: MANAGERS,
  addComplaint: NOT_EXEC,
  viewAllExperiences: ['branch_manager', 'operations', 'quality', 'executive', 'admin'],
  analytics: ['branch_manager', 'operations', 'quality', 'executive', 'admin'],
  viewCases: ['case_officer', ...MANAGERS, 'executive'],
  handleCases: ['case_officer', ...MANAGERS],          // contact, note, change status, close (subject to approval)
  assignCases: MANAGERS,
  approveCases: MANAGERS,                               // approve closing high-severity cases
  manageSetup: ['quality', 'admin'],                    // users, doctors, categories, Google connection
  fullPhones: ['case_officer', ...MANAGERS]
};

/** Roles limited to one branch when the user has a branch set. */
const BRANCH_SCOPED = ['branch_manager', 'case_officer'];

function can(user, perm) {
  if (!PERMS[perm]) throw new Error(`unknown permission ${perm}`);
  return !!user && PERMS[perm].includes(user.role);
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
  return Object.keys(PERMS).filter(p => can(user, p));
}

module.exports = { ROLES, ROLE_LABELS, PERMS, can, requirePerm, branchScope, assertBranch, permsOf };
