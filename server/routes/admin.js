'use strict';

const express = require('express');
const { must, audit } = require('../db');
const { hashPassword, randomPassword } = require('../auth');
const { ROLE_LABELS } = require('../access');
const { formatLocal } = require('../time');
const {
  UserError, UUID_RE, parse, userCreateSchema, userUpdateSchema, doctorSchema, categorySchema
} = require('../validate');

function checkId(id, what) {
  if (!UUID_RE.test(id)) throw new UserError(`${what} غير موجود`, 404);
}

function uniqueViolation(e, msg) {
  if (e && e.code === '23505') throw new UserError(msg, 409);
  throw e;
}

function userRow(u, tz) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role, branch: u.branch,
    active: u.active, mustChange: u.must_change, lastLogin: formatLocal(u.last_login, tz)
  };
}

/** GET/POST/PATCH for a simple lookup table (doctors, categories). Records are deactivated, never deleted. */
function lookupTable(r, path, { table, schema, label, dupMsg, auditName }) {
  r.get(path, async (req, res) => {
    res.json({ ok: true, rows: await must(req.ctx.db.from(table).select('*').order('name')) });
  });
  r.post(path, async (req, res) => {
    const d = parse(schema, req.body);
    const row = await must(req.ctx.db.from(table).insert({ ...d, active: d.active ?? true }).select('*').single())
      .catch(e => uniqueViolation(e, dupMsg));
    await audit(req.ctx.db, req.user.username, `add_${auditName}`, d.name);
    res.status(201).json({ ok: true, row });
  });
  r.patch(`${path}/:id`, async (req, res) => {
    checkId(req.params.id, label);
    const d = parse(schema.partial(), req.body);
    const rows = await must(req.ctx.db.from(table).update(d).eq('id', req.params.id).select('*'))
      .catch(e => uniqueViolation(e, dupMsg));
    if (!rows.length) throw new UserError(`${label} غير موجود`, 404);
    await audit(req.ctx.db, req.user.username, `update_${auditName}`, `${rows[0].name} ${JSON.stringify(d)}`);
    res.json({ ok: true, row: rows[0] });
  });
}

function adminRoutes() {
  const r = express.Router();

  r.get('/users', async (req, res) => {
    const users = await must(req.ctx.db.from('app_users').select('*').order('username'));
    res.json({ ok: true, rows: users.map(u => userRow(u, req.ctx.config.tz)) });
  });

  r.post('/users', async (req, res) => {
    const { db } = req.ctx;
    const d = parse(userCreateSchema, req.body);
    const tempPassword = randomPassword();
    const row = await must(db.from('app_users').insert({
      ...d, password_hash: await hashPassword(tempPassword), active: true, must_change: true
    }).select('*').single()).catch(e => uniqueViolation(e, 'اسم المستخدم مستخدم من قبل'));
    await audit(db, req.user.username, 'add_user', d.username);
    res.status(201).json({ ok: true, row: userRow(row, req.ctx.config.tz), tempPassword });
  });

  r.patch('/users/:id', async (req, res) => {
    const { db } = req.ctx;
    checkId(req.params.id, 'المستخدم');
    const d = parse(userUpdateSchema, req.body);
    const self = req.params.id === req.user.id;
    if (self && (d.active === false || (d.role && d.role !== req.user.role))) {
      throw new UserError('لا يمكنك تعطيل حسابك أو تغيير دورك');
    }
    const patch = {};
    for (const k of ['name', 'role', 'branch', 'active']) if (d[k] !== undefined) patch[k] = d[k];
    const current = await must(db.from('app_users').select('role,branch').eq('id', req.params.id).maybeSingle());
    if (!current) throw new UserError('المستخدم غير موجود', 404);
    const role = patch.role ?? current.role, branch = patch.branch !== undefined ? patch.branch : current.branch;
    if (role === 'branch_manager' && !branch) throw new UserError('حدد فرع مدير الفرع');
    let tempPassword = null;
    if (d.resetPassword) {
      tempPassword = randomPassword();
      patch.password_hash = await hashPassword(tempPassword);
      patch.must_change = true;
    }
    if (!Object.keys(patch).length) throw new UserError('لا توجد تغييرات');
    const rows = await must(db.from('app_users').update(patch).eq('id', req.params.id).select('*'));
    if (!rows.length) throw new UserError('المستخدم غير موجود', 404);
    const changed = Object.keys(patch).filter(k => k !== 'password_hash').join(',');
    await audit(db, req.user.username, 'update_user', `${rows[0].username}: ${changed}`);
    res.json({ ok: true, row: userRow(rows[0], req.ctx.config.tz), tempPassword });
  });

  lookupTable(r, '/doctors', { table: 'doctors', schema: doctorSchema, label: 'الطبيب', dupMsg: 'يوجد طبيب بنفس الاسم', auditName: 'doctor' });
  lookupTable(r, '/categories', { table: 'categories', schema: categorySchema, label: 'التصنيف', dupMsg: 'يوجد تصنيف بنفس الاسم', auditName: 'category' });

  return r;
}

module.exports = adminRoutes;
