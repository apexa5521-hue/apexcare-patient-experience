'use strict';

// Google review comments: which staff are mentioned by role or name, and how the names are matched.
// The functions are read from public/index.html so the test runs the code the browser runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const from = html.indexOf('function revNorm(');
const to = html.indexOf('function revInsightBlock(');
const ctx = { S: { lk: { doctors: [{ name: 'د. بسام المالكي', active: true }, { name: 'د. صالح الصدراني', active: true }] } } };
vm.runInNewContext(html.slice(from, to), ctx);
const people = (comment) => JSON.parse(JSON.stringify(ctx.revPeople({ comment })));
const summary = (comment) => people(comment).map(p => [p.kind, p.name, p.confidence]);

test('a doctor from the directory is matched by full name and marked as directory', () => {
  assert.deepEqual(summary('الدكتور بسام المالكي ممتاز جداً'), [
    ['doctor', 'د. بسام المالكي', 'directory']
  ]);
});

test('a first name alone matches the one doctor who has it', () => {
  assert.deepEqual(summary('الدكتور صالح شرح لي كل شي'), [
    ['doctor', 'د. صالح الصدراني', 'first-name']
  ]);
});

test('a nurse named in the comment is kept as written, unverified', () => {
  assert.deepEqual(summary('الممرضة سارة كانت لطيفة'), [
    ['nurse', 'سارة', 'as-written']
  ]);
});

test('reception and customer service never take a following word as a name', () => {
  assert.deepEqual(summary('موظفة الاستقبال منى تعاملت بشكل ممتاز'), [
    ['staff', '', 'role-only'],
    ['reception', '', 'role-only']
  ]);
});

test('English words after a title are not names, and verbs after a role are not names', () => {
  assert.deepEqual(summary('الممرضة Wadha كانت ممتازة'), [['nurse', '', 'role-only']]);
  assert.deepEqual(summary('الاستقبال تفاجأت انه'), [['reception', '', 'role-only']]);
});

test('a role with no name is role-only, and adjectives or verbs are never taken as names', () => {
  assert.deepEqual(summary('الموظف كان سيئ جداً'), [
    ['staff', '', 'role-only']
  ]);
  assert.deepEqual(summary('الاستقبال تعامل رديء'), [
    ['reception', '', 'role-only']
  ]);
});

test('customer service is recognised by its phrase', () => {
  assert.deepEqual(summary('خدمة العملاء ما ردوا علي'), [
    ['customer_service', '', 'role-only']
  ]);
});

test('comments with no staff mention produce no people', () => {
  assert.deepEqual(people('المكان نظيف والخدمة جيدة'), []);
  assert.deepEqual(people(''), []);
});

test('the same person mentioned twice is counted once', () => {
  assert.equal(people('الممرضة سارة والممرضة سارة').length, 1);
});

test('the reviews insight panel renders the people section from real comment rows', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = page.indexOf('function revNorm(');
  const end = page.indexOf('function revDrawInsight(');
  const panel = {
    S: ctx.S,
    REV_I: { view: 'all', doctor: '', search: '' },
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
  vm.runInNewContext(page.slice(start, end), panel);
  const rows = [
    { comment: 'الممرضة سارة كانت لطيفة', rating: 5 },
    { comment: 'الدكتور بسام المالكي ممتاز', rating: 5 },
    { comment: 'خدمة العملاء ما ردوا علي', rating: 1 },
    { comment: '', rating: 4 }
  ].map(r => ({ ...r, branch: 'بريدة', createdAt: '', status: 'جديد', reply: '' }));
  const html = panel.revInsightBlock(panel.revInsightRows(rows));
  assert.match(html, /الأشخاص المذكورون/);
  assert.match(html, /سارة/);
  assert.match(html, /بسام المالكي ✓/);
  assert.match(html, /خدمة العملاء/);
});
