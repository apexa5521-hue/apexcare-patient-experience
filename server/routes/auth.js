'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { must, audit } = require('../db');
const { UserError, parse, passwordChangeSchema } = require('../validate');
const {
  checkPassword, hashPassword, signToken, publicUser, authenticate
} = require('../auth');

const BAD_LOGIN = 'اسم المستخدم أو كلمة المرور غير صحيحة';
// Compared against when the username doesn't exist, so timing doesn't leak which names are real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function authRoutes() {
  const r = express.Router();

  const loginLimit = rateLimit({
    windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { ok: false, error: 'محاولات دخول كثيرة. حاول بعد قليل' }
  });

  r.post('/login', loginLimit, async (req, res) => {
    const { db, config, loginLimiter } = req.ctx;
    const username = String(req.body?.username || '').trim().toLowerCase().slice(0, 30);
    const password = String(req.body?.password || '');
    if (!username || !password) throw new UserError('أدخل اسم المستخدم وكلمة المرور');
    if (loginLimiter.isLocked(username)) {
      throw new UserError('تم إيقاف المحاولات مؤقتاً. حاول بعد 10 دقائق', 429);
    }
    const user = await must(db.from('app_users').select('*').eq('username', username).maybeSingle());
    const ok = await checkPassword(password, user?.password_hash || DUMMY_HASH);
    if (!user || !user.active || !ok) {
      loginLimiter.fail(username);
      await audit(db, username, 'login_failed', user && !user.active ? 'inactive' : '');
      throw new UserError(BAD_LOGIN, 401);
    }
    loginLimiter.reset(username);
    await must(db.from('app_users').update({ last_login: new Date().toISOString() }).eq('id', user.id));
    await audit(db, user.username, 'login', '');
    res.json({ ok: true, token: signToken(user, config.jwtSecret), user: publicUser(user) });
  });

  r.get('/me', authenticate, (req, res) => {
    res.json({ ok: true, user: publicUser(req.user) });
  });

  r.post('/change-password', authenticate, async (req, res) => {
    const { db } = req.ctx;
    const d = parse(passwordChangeSchema, req.body);
    if (!(await checkPassword(d.oldPassword, req.user.password_hash))) throw new UserError('كلمة المرور الحالية غير صحيحة');
    if (d.oldPassword === d.newPassword) throw new UserError('اختر كلمة مرور مختلفة عن الحالية');
    await must(db.from('app_users').update({ password_hash: await hashPassword(d.newPassword), must_change: false }).eq('id', req.user.id));
    await audit(db, req.user.username, 'change_password', '');
    res.json({ ok: true });
  });

  r.post('/logout', authenticate, async (req, res) => {
    req.ctx.revocations.add(req.token.jti, req.token.exp);
    await audit(req.ctx.db, req.user.username, 'logout', '');
    res.json({ ok: true });
  });

  return r;
}

module.exports = authRoutes;
