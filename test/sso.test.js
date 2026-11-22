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

/* ---------- tickets from the operations platform (ES256, its organization's public key) ---------- */
{
  const { generateKeyPairSync } = crypto;
  const pair = () => {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { pub: k.publicKey.export({ type: 'spki', format: 'pem' }), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  };
  const platform = pair(), stranger = pair();
  const pTicket = (sub, over = {}, priv = platform.priv) => jwt.sign({ email: `${sub}@apexcare.sa`, org: 'apexcare', ...over },
    priv, { algorithm: 'ES256', issuer: 'apexcare-platform', audience: 'patient-experience', subject: sub, expiresIn: 60, jwtid: crypto.randomUUID() });
  let p;
  test('platform sso: start with only SSO_PUBLIC_KEY (written with \\n escapes)', async () => {
    p = await startApp({ ssoPublicKey: require('../server/sso').readPublicKey(platform.pub.replace(/\n/g, '\\n')), ssoAppId: 'patient-experience' });
    p.addUser({ username: 'reem', role: 'staff', branch: 'بريدة' });
  });
  test('platform sso: a ticket signed by the platform opens a session, once', async () => {
    const tk = pTicket('reem');
    const r = await p.call('POST', '/api/auth/sso', { body: { ticket: tk } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.username, 'reem');
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: tk } })).status, 401, 'single use');
  });
  test('platform sso: wrong key, wrong system, old-portal tickets and HS256 forgeries are refused', async () => {
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: pTicket('reem', {}, stranger.priv) } })).status, 401);
    const other = jwt.sign({}, platform.priv, { algorithm: 'ES256', issuer: 'apexcare-platform', audience: 'masar', subject: 'reem', expiresIn: 60, jwtid: 'x1' });
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: other } })).status, 401);
    // an HS256 token "signed" with the public key text must not pass (algorithm confusion)
    const forged = jwt.sign({}, platform.pub, { algorithm: 'HS256', issuer: 'apexcare-platform', audience: 'patient-experience', subject: 'reem', expiresIn: 60, jwtid: 'x2' });
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: forged } })).status, 401);
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: ticket('reem') } })).status, 401, 'no SSO_SECRET here');
  });
  // the platform does not know the employee's account here yet: it sends their e-mail only
  const unlinked = (email, priv = platform.priv) => jwt.sign({ email, org: 'apexcare', sub: '' },
    priv, { algorithm: 'ES256', issuer: 'apexcare-platform', audience: 'patient-experience', expiresIn: 60, jwtid: crypto.randomUUID() });
  test('platform sso: an employee not linked yet signs in here once, and is linked from then on', async () => {
    const first = await p.call('POST', '/api/auth/sso', { body: { ticket: unlinked('Noura@ApexCare.sa') } });
    assert.equal(first.status, 409);
    assert.match(first.body.link, /^[\w-]{20,}$/);
    assert.match(first.body.error, /مرة واحدة/);
    const login = await p.call('POST', '/api/auth/login', { body: { username: 'reem', password: 'password123' } });
    // a made-up code links nothing
    assert.equal((await p.call('POST', '/api/auth/sso/link', { token: login.body.token, body: { code: 'nope' } })).status, 400);
    assert.equal((await p.call('POST', '/api/auth/sso/link', { token: login.body.token, body: { code: first.body.link } })).status, 200);
    assert.equal((await p.call('POST', '/api/auth/sso/link', { token: login.body.token, body: { code: first.body.link } })).status, 400, 'a code works once');
    const next = await p.call('POST', '/api/auth/sso', { body: { ticket: unlinked('noura@apexcare.sa') } });
    assert.equal(next.status, 200);
    assert.equal(next.body.user.username, 'reem', 'opens directly now');
    assert.ok(p.db._store.tables.audit_log.some(a => a.action === 'sso_linked' && a.username === 'reem'));
  });
  test('platform sso: an e-mail-only ticket must come from the platform, signed by its key', async () => {
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: unlinked('noura@apexcare.sa', stranger.priv) } })).status, 401);
    // the old portal (HS256) cannot use the e-mail-only form
    const old = jwt.sign({ iss: 'apex-portal', aud: 'patient-experience', sub: '', email: 'noura@apexcare.sa' }, SECRET, { algorithm: 'HS256', expiresIn: 60, jwtid: crypto.randomUUID() });
    assert.equal((await p.call('POST', '/api/auth/sso', { body: { ticket: old } })).status, 401);
  });
  test('platform sso: close', async () => { await p.close(); });
  test('readPublicKey accepts a PEM and refuses anything else', () => {
    const { readPublicKey } = require('../server/sso');
    assert.match(readPublicKey(platform.pub), /BEGIN PUBLIC KEY/);
    assert.equal(readPublicKey('not a key'), '');
    assert.equal(readPublicKey(''), '');
  });
}
