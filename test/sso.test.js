'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { startApp } = require('./helpers');
const { UsedTickets, verifyTicket } = require('../server/sso');

const SECRET = 'portal-sso-secret-portal-sso-secret-0123';

/** A ticket shaped like the ones the portal (Apps Script) signs. */
function ticket(sub, over = {}, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: 'apex-portal', aud: 'patient-experience', sub, email: `${sub}@apexcare.sa`, iat: now, exp: now + 60, jti: crypto.randomUUID(), ...over },
    secret, { algorithm: 'HS256' });
}

let t;
test.before(async () => {
  t = await startApp({ ssoSecret: SECRET, ssoAppId: 'patient-experience' });
  t.addUser({ username: 'reem', role: 'staff', branch: 'بريدة' });
  t.addUser({ username: 'gone', active: false });
});
test.after(() => t.close());

const sso = tk => t.call('POST', '/api/auth/sso', { body: { ticket: tk } });

test('sso: a valid ticket gives an ordinary session for that user', async () => {
  const r = await sso(ticket('reem'));
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'reem');
  const me = await t.call('GET', '/api/auth/me', { token: r.body.token });
  assert.equal(me.status, 200);
  assert.equal((await t.call('GET', '/api/lookups', { token: r.body.token })).status, 200);
  assert.ok(t.db._store.tables.audit_log.some(a => a.action === 'login_sso' && a.username === 'reem'));
});

test('sso: the username in the ticket is matched case-insensitively', async () => {
  assert.equal((await sso(ticket('Reem'))).status, 200);
});

test('sso: each ticket works once', async () => {
  const tk = ticket('reem');
  assert.equal((await sso(tk)).status, 200);
  const again = await sso(tk);
  assert.equal(again.status, 401);
  assert.match(again.body.error, /البوابة/);
});

test('sso: rejected tickets', async () => {
  const now = Math.floor(Date.now() / 1000);
  const bad = {
    'wrong secret': ticket('reem', {}, 'another-secret-another-secret-another-1'),
    'other platform': ticket('reem', { aud: 'nurse-report' }),
    'other issuer': ticket('reem', { iss: 'someone-else' }),
    expired: ticket('reem', { iat: now - 300, exp: now - 240 }),
    'too long-lived': ticket('reem', { exp: now + 3600 }),
    'no id': ticket('reem', { jti: undefined }),
    'unknown user': ticket('nobody'),
    'disabled user': ticket('gone'),
    'odd username': ticket("' or 1=1--"),
    'not a jwt': 'garbage',
    'alg none': jwt.sign({ iss: 'apex-portal', aud: 'patient-experience', sub: 'reem', jti: 'x' }, '', { algorithm: 'none' })
  };
  for (const [why, tk] of Object.entries(bad)) {
    const r = await sso(tk);
    assert.equal(r.status, 401, why);
    assert.equal(r.body.ok, false, why);
  }
  const missing = await t.call('POST', '/api/auth/sso', { body: {} });
  assert.equal(missing.status, 401);
});

test('sso: password login still works next to it', async () => {
  assert.ok(await t.login('reem'));
});

test('sso: off when no SSO_SECRET is set', async () => {
  const plain = await startApp();
  try {
    plain.addUser({ username: 'reem' });
    const r = await plain.call('POST', '/api/auth/sso', { body: { ticket: ticket('reem') } });
    assert.equal(r.status, 404);
    assert.ok(await plain.login('reem'));
  } finally { await plain.close(); }
});

test('UsedTickets forgets ids once their ticket has expired', () => {
  let now = 1_000_000;
  const u = new UsedTickets({ now: () => now });
  assert.equal(u.claim('a', 1_000), true);
  assert.equal(u.claim('a', 1_000), false);
  now = 1_000_001;
  assert.equal(u.claim('a', 2_000), true);
});

test('verifyTicket needs a secret', () => {
  assert.equal(verifyTicket(ticket('reem'), { secret: '', appId: 'patient-experience', used: new UsedTickets() }), null);
});

test('loadConfig: SSO is optional, but a short SSO_SECRET is refused', () => {
  const { loadConfig } = require('../server/index');
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'x'.repeat(40), WEBHOOK_SECRET: 'w' };
  assert.equal(loadConfig(env).ssoSecret, '');
  assert.equal(loadConfig({ ...env, SSO_SECRET: 's'.repeat(40) }).ssoAppId, 'patient-experience');
  assert.throws(() => loadConfig({ ...env, SSO_SECRET: 'short' }), /SSO_SECRET/);
});
