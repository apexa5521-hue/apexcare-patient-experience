'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { must } = require('./db');
const { UserError } = require('./validate');

const BCRYPT_COST = 12;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const SESSION_EXPIRED = 'انتهت الجلسة، سجّل الدخول من جديد';

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);
const checkPassword = (pw, hash) => bcrypt.compare(String(pw), String(hash || ''));

// No look-alike characters (0/O, 1/l/I) so temp passwords can be read out loud.
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomPassword(len = 10) {
  let s = '';
  for (let i = 0; i < len; i++) s += PW_CHARS[crypto.randomInt(PW_CHARS.length)];
  return s;
}

/** Failed-login counter per username, in memory: `max` failures within `windowMs` locks the name. */
class LoginLimiter {
  constructor({ max = 5, windowMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max; this.windowMs = windowMs; this.now = now;
    this.fails = new Map();
  }
  recent(username) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.fails.get(username) || []).filter(t => t > cutoff);
    if (list.length) this.fails.set(username, list); else this.fails.delete(username);
    return list;
  }
  isLocked(username) { return this.recent(username).length >= this.max; }
  fail(username) { this.fails.set(username, [...this.recent(username), this.now()]); }
  reset(username) { this.fails.delete(username); }
}

/** Revoked token ids, kept until the token would have expired anyway. */
class Revocations {
  constructor() { this.ids = new Map(); }
  add(jti, expSeconds) { this.ids.set(jti, expSeconds * 1000); this.sweep(); }
  has(jti) { return this.ids.has(jti); }
  sweep() { const now = Date.now(); for (const [k, exp] of this.ids) if (exp < now) this.ids.delete(k); }
}

function signToken(user, secret) {
  return jwt.sign({ sub: user.id, role: user.role }, secret, {
    algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS, jwtid: crypto.randomUUID()
  });
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, branch: u.branch, mustChange: !!u.must_change };
}

/** Verifies the bearer token and loads the (active) user onto req.user. */
function authenticate(req, _res, next) {
  const { db, config, revocations } = req.ctx;
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return next(new UserError(SESSION_EXPIRED, 401));
  let claims;
  try {
    claims = jwt.verify(m[1], config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return next(new UserError(SESSION_EXPIRED, 401));
  }
  if (revocations.has(claims.jti)) return next(new UserError(SESSION_EXPIRED, 401));
  must(db.from('app_users').select('*').eq('id', claims.sub).maybeSingle())
    .then(user => {
      if (!user || !user.active) throw new UserError(SESSION_EXPIRED, 401);
      req.user = user;
      req.token = claims;
      next();
    })
    .catch(next);
}

/** Blocks everything until a temporary password has been replaced. */
function requirePasswordChanged(req, _res, next) {
  if (req.user.must_change) return next(new UserError('يجب تغيير كلمة المرور أولاً', 403));
  next();
}

function requireAdmin(req, _res, next) {
  if (req.user.role !== 'admin') return next(new UserError('لا تملك صلاحية لهذا الإجراء', 403));
  next();
}

const isAdmin = (user) => user && user.role === 'admin';

module.exports = {
  hashPassword, checkPassword, randomPassword, LoginLimiter, Revocations, signToken, publicUser,
  authenticate, requirePasswordChanged, requireAdmin, isAdmin, TOKEN_TTL_SECONDS
};
