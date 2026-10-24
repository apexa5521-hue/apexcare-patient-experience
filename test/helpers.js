'use strict';

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/index');
const { createFakeSupabase } = require('./fake-supabase');

const CONFIG = {
  jwtSecret: 'test-secret-test-secret-test-secret-0123456789',
  webhookSecret: 'hook-secret',
  tz: 'Asia/Riyadh',
  overdueDays: 3
};

async function startApp(overrides = {}) {
  const db = createFakeSupabase();
  const app = createApp({ db, config: { ...CONFIG, ...overrides } });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  // Low bcrypt cost keeps the suite fast; verification works for any cost.
  function addUser({ username, role = 'staff', branch = null, password = 'password123', mustChange = false, active = true, name }) {
    const row = {
      id: require('node:crypto').randomUUID(), username, name: name || username, role, branch,
      password_hash: bcrypt.hashSync(password, 4), active, must_change: mustChange,
      created_at: new Date().toISOString(), last_login: null
    };
    db._store.tables.app_users.push(row);
    return row;
  }

  function addDoctor({ name, specialty = 'أسنان', branch = 'بريدة', active = true }) {
    const row = { id: require('node:crypto').randomUUID(), name, specialty, branch, active };
    db._store.tables.doctors.push(row);
    return row;
  }

  async function login(username, password = 'password123') {
    const r = await call('POST', '/api/auth/login', { body: { username, password } });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  return {
    db, base, call, addUser, addDoctor, login,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

/** A complete, valid experience payload for the given doctor. */
function experience(doctorId, over = {}) {
  return {
    fileNo: 'A-1001', phone: '0551234567', branch: 'بريدة', doctorId,
    visitDate: '2026-03-10', visitTime: '10:30', visitType: 'إجراء',
    bookingRating: 5, receptionRating: 4, planExplained: 'نعم', doctorRating: 5,
    sentiment: 'إيجابية', ...over
  };
}

module.exports = { startApp, experience, CONFIG };
