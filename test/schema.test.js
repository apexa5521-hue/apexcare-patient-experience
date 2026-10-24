'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA } = require('./fake-supabase');

const ROOT = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');

function tablesFromSql() {
  const out = {};
  const re = /create table if not exists (\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    out[m[1]] = m[2].split('\n').map(l => l.trim()).filter(l => /^[a-z_]+\s/.test(l)).map(l => l.split(/\s+/)[0]);
  }
  return out;
}

test('test fake mirrors supabase/schema.sql columns', () => {
  const tables = tablesFromSql();
  assert.deepEqual(Object.keys(tables).sort(), Object.keys(SCHEMA).sort());
  for (const [t, cols] of Object.entries(tables)) {
    assert.deepEqual([...SCHEMA[t].cols].sort(), [...cols].sort(), t);
  }
});

test('row level security is enabled on every table, with no policies', () => {
  for (const t of Object.keys(tablesFromSql())) {
    assert.match(sql, new RegExp(`alter table ${t}\\s+enable row level security;`), t);
  }
  assert.equal(/create policy/i.test(sql), false);
});

test('no patient-name field exists in the database, UI or sheet integration', () => {
  for (const cols of Object.values(tablesFromSql())) {
    assert.equal(cols.some(c => /patient|name_ar|full_name/.test(c)), false, cols.join(','));
  }
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal(/name=["'](patientName|patient_name)/.test(ui), false);
  assert.equal(ui.includes('اسم المريض</label>'), false);
});

test('service role key never reaches public/', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    const body = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    assert.equal(/service_role|SUPABASE|eyJhbGci/.test(body), false, f);
  }
});
