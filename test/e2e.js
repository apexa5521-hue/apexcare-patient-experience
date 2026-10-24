'use strict';

// Browser test (Playwright): login → change password → record a full experience →
// it appears in the log → it appears in the KPIs. Runs on phone (390px) and desktop (1280px)
// against the in-memory fake database and saves screenshots to test-artifacts/.
// Usage: node test/e2e.js

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const { createApp } = require('../server/index');
const { createFakeSupabase } = require('./fake-supabase');
const { CONFIG } = require('./helpers');

const OUT = path.join(__dirname, '..', 'test-artifacts');

function seed(db) {
  const t = db._store.tables;
  t.app_users.push({
    id: crypto.randomUUID(), username: 'admin', name: 'مدير النظام', role: 'admin', branch: null,
    password_hash: bcrypt.hashSync('Temp-Pass-1', 4), active: true, must_change: true, created_at: new Date().toISOString(), last_login: null
  });
  const docs = [['د. سارة العتيبي', 'أسنان', 'بريدة'], ['د. خالد الحربي', 'جلدية', 'الكل'], ['د. منى السالم', 'أسنان', 'عنيزة']]
    .map(([name, specialty, branch]) => ({ id: crypto.randomUUID(), name, specialty, branch, active: true }));
  t.doctors.push(...docs);
  const staff = { id: crypto.randomUUID(), username: 'seed', name: 'seed', role: 'staff', branch: null, password_hash: 'x', active: true, must_change: false, created_at: new Date().toISOString(), last_login: null };
  t.app_users.push(staff);
  const mk = (username, name, role, branch = null) => ({ id: crypto.randomUUID(), username, name, role, branch,
    password_hash: bcrypt.hashSync('Role-Pass-1', 4), active: true, must_change: false, created_at: new Date().toISOString(), last_login: null });
  t.app_users.push(mk('officer', 'نورة المتابعة', 'case_officer'), mk('ceo', 'المدير التنفيذي', 'executive'), mk('bm.b', 'مدير بريدة', 'branch_manager', 'بريدة'));
  // Some history so the KPI charts have shape.
  const sentiments = ['إيجابية', 'إيجابية', 'إيجابية', 'محايدة', 'سلبية'];
  const cats = ['وقت الانتظار', 'تأخر الموعد', 'أسلوب التعامل', 'التكلفة والأسعار'];
  let r = 7;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 160; i++) {
    const d = docs[Math.floor(rnd() * docs.length)];
    const s = sentiments[Math.floor(rnd() * sentiments.length)];
    const daysAgo = Math.floor(rnd() * 200) + 1;
    const at = new Date(Date.now() - daysAgo * 86400000);
    at.setUTCHours(5 + Math.floor(rnd() * 15), Math.floor(rnd() * 60));
    const branch = d.branch === 'الكل' ? (rnd() > 0.5 ? 'بريدة' : 'عنيزة') : d.branch;
    t.experiences.push({
      id: crypto.randomUUID(), created_at: at.toISOString(), visit_at: at.toISOString(),
      visit_time_local: null, file_no: `H-${1000 + i}`, phone: null, doctor_id: d.id, branch, specialty: d.specialty,
      visit_type: ['كشف', 'إجراء', 'كشف وإجراء'][i % 3], sentiment: s,
      category: s === 'سلبية' ? cats[i % cats.length] : null, severity: s === 'سلبية' ? ['بسيطة', 'متوسطة', 'عالية'][i % 3] : null,
      follow_up: s === 'سلبية' ? 'جديدة' : null,
      booking_rating: s === 'سلبية' ? 2 + (i % 3) : 4 + (i % 2), reception_rating: s === 'سلبية' ? 1 + (i % 3) : 3 + (i % 3),
      plan_explained: ['نعم', 'نعم', 'جزئياً', 'لا'][i % 4], doctor_rating: s === 'سلبية' ? 2 + (i % 2) : 4 + (i % 2),
      general_note: null, created_by: staff.id
    });
  }
  for (let i = 0; i < 24; i++) {
    const lo = i % 6 === 0;
    t.service_ratings.push({ id: crypto.randomUUID(), created_at: new Date(Date.now() - (i + 1) * 3 * 86400000).toISOString(), source_key: `seed:${i}`,
      branch: i % 2 ? 'بريدة' : 'عنيزة', visit_at: null, q_booking: 5 - (i % 2), q_reception: lo ? 2 : 4 + (i % 2), q_waiting: lo ? 1 : 3 + (i % 3),
      q_explanation: 5, q_care: lo ? 2 : 4, q_recommend: lo ? 2 : 5 - (i % 2), q_overall: lo ? 1 : 5 - (i % 3), comment: null });
  }
  for (const e of t.experiences) e.visit_time_local = db._schema.experiences.compute(e).visit_time_local;
  t.complaints.push({
    id: crypto.randomUUID(), created_at: new Date(Date.now() - 6 * 86400000).toISOString(), file_no: 'C-9', phone: '0551231234',
    doctor_id: docs[0].id, doctor_name_raw: null, branch: 'بريدة', category: 'التكلفة والأسعار', severity: 'عالية', status: 'جديدة',
    description: 'تفاوت في السعر بين التقدير والفاتورة', source: 'شيت الشكاوى', source_key: 'x:1', assigned_to: null, resolution: null, closed_at: null, updated_by: 'sheet'
  });
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const db = createFakeSupabase();
  seed(db);
  const app = createApp({ db, config: CONFIG });
  const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const failures = [];

  for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) problems.push(m.text()); });
    page.on('pageerror', e => problems.push(e.message));
    const shot = async n => page.screenshot({ path: path.join(OUT, `${vp.name}-${n}.png`), fullPage: true });
    const noHScroll = async where => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `${vp.name} ${where}: horizontal page scroll of ${over}px`);
    };

    try {
      await page.goto(base);
      await shot('01-login');
      await noHScroll('login');
      const pw = vp.name === 'mobile' ? 'Temp-Pass-1' : 'New-Pass-123';
      await page.fill('#lgUser', 'admin');
      await page.fill('#lgPass', pw);
      await page.click('#loginForm button[type=submit]');

      if (vp.name === 'mobile') {
        await page.waitForSelector('#pwForm');
        await shot('02-change-password');
        await page.fill('#pwOld', 'Temp-Pass-1');
        await page.fill('#pwNew', 'New-Pass-123');
        await page.click('#pwForm button[type=submit]');
      }
      await page.waitForSelector('#exForm #exDoctor option:nth-child(2)', { state: 'attached' });
      await page.waitForSelector('#modal.hidden', { state: 'attached' });

      // Submitting empty shows inline errors, not a crash.
      await page.click('#exSave');
      await page.waitForSelector('.field.invalid');
      const errCount = await page.locator('.field.invalid').count();
      assert.ok(errCount >= 8, `expected inline errors, got ${errCount}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot('03-form-errors');

      const fileNo = `E2E-${vp.name === 'mobile' ? 'M' : 'D'}`;
      await page.fill('#exFile', fileNo);
      await page.fill('#exPhone', '0551234567');
      await page.selectOption('#exBranch', 'بريدة');
      await page.selectOption('#exDoctor', { label: 'د. سارة العتيبي — أسنان' });
      await page.click('#vtSeg label:has-text("كشف"):not(:has-text("وإجراء"))');
      // "لا ينطبق" appears only for كشف
      assert.equal(await page.locator('#planSeg label:has-text("لا ينطبق")').count(), 1);
      await page.click('#vtSeg label:has-text("إجراء") >> nth=0');
      await page.click('#vtSeg label:has-text("كشف وإجراء")');
      assert.equal(await page.locator('#planSeg label:has-text("لا ينطبق")').count(), 0);
      await page.click('[data-stars=bookingRating] label >> nth=4');
      await page.click('[data-stars=receptionRating] label >> nth=3');
      await page.click('#planSeg label:has-text("نعم")');
      // keyboard: focus doctor star 1 and arrow to 4
      await page.focus('[data-stars=doctorRating] input >> nth=0');
      await page.keyboard.press('Space');
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
      const doctorVal = await page.$eval('[data-stars=doctorRating] input:checked', i => i.value);
      assert.equal(doctorVal, '4', 'arrow keys move the star rating (RTL)');
      await page.click('#sentSeg label:has-text("سلبية")');
      await page.waitForSelector('#negBox:not(.hidden)');
      await page.selectOption('#exCat', 'وقت الانتظار');
      await page.click('#sevSeg label:has-text("متوسطة")');
      await page.waitForTimeout(350); // let the segmented thumb finish sliding before the screenshot
      await page.fill('#exNote', 'انتظر المريض 40 دقيقة بعد موعده');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot('04-form-filled');
      await noHScroll('form');
      await page.click('#exSave');
      await page.waitForSelector('#toast.on:not(.err)');
      assert.equal(await page.inputValue('#exFile'), '', 'form cleared after save');
      assert.equal(await page.inputValue('#exBranch'), 'بريدة', 'branch kept after save');
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(focused, 'exFile', 'focus returns to file number');

      await page.click('#tabs button[data-tab=log]');
      await page.waitForSelector(`#logTable td:has-text("${fileNo}")`);
      const row = page.locator('#logTable tr', { hasText: fileNo });
      assert.match(await row.innerText(), /سلبية/);
      assert.match(await row.innerText(), /وقت الانتظار/);
      await shot('05-log');

      await page.click('#tabs button[data-tab=complaints]');
      await page.waitForSelector('#coTable td:has-text("C-9")');
      assert.equal(await page.locator('#coTable tr.overdue').count(), 1);
      await shot('06-complaints');
      await noHScroll('complaints');

      await page.click('#tabs button[data-tab=kpi]');
      await page.waitForSelector('#kpiBody .rating-card');
      await page.waitForSelector('#kpiBody h3:has-text("صوت المريض من كل المصادر")');
      await page.waitForSelector('#kpiBody h3:has-text("تقييم الخدمة (باركود)")');
      const total = await page.locator('#kpiBody .tile.hero .v').innerText();
      assert.equal(total.trim(), vp.name === 'mobile' ? '161' : '163', 'new experiences counted in KPIs (desktop also sees the mobile phone survey)');
      assert.ok(await page.locator('#kpiBody tr:has-text("د. سارة العتيبي")').count() >= 1);
      const col = page.locator('#kpiBody .cols .c >> nth=3');
      await col.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await col.hover();
      await page.waitForSelector('#tip.on');
      await shot('07-kpis');
      await noHScroll('kpis');

      await page.click('#tabs button[data-tab=admin]');
      await page.waitForSelector('#docTable td:has-text("د. منى السالم")');
      await page.click('#newUser');
      await page.fill('#uUser', `staff.${vp.name}`);
      await page.fill('#uName', 'موظفة الاستقبال');
      await page.click('#uForm button[type=submit]');
      await page.waitForSelector('#tempPw');
      const temp = (await page.innerText('#tempPw')).trim();
      assert.match(temp, /^[A-Za-z0-9]{10}$/);
      await shot('08-temp-password');
      await page.click('#modalBody [data-close]');
      await shot('09-admin');
      await noHScroll('admin');

      // Call list: import from Excel (with a patient-name column that must be ignored), then survey by phone.
      const tag = vp.name === 'mobile' ? 'M' : 'D';
      await page.click('#tabs button[data-tab=calls]');
      await page.waitForSelector('#callTable');
      await page.click('#importCalls');
      const paste = [
        'رقم الملف\tاسم المريض\tالجوال\tالطبيب\tتاريخ الزيارة\tالوقت',
        `CALL-${tag}1\tمريض تجريبي\t0551112233\tد. سارة العتيبي\t${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}\t10:15`,
        `CALL-${tag}2\tمريض آخر\t0551112244\tد. خالد الحربي\t${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}\t11:40`,
        `BAD ROW\tx\t123\t\t\t`
      ].join('\n');
      await page.fill('#impText', paste);
      await page.waitForSelector('#impGo:not([disabled])');
      assert.match(await page.innerText('#impHint'), /3 صف/);
      await page.click('#impGo');
      await page.waitForSelector('#impResult .alert');
      assert.match(await page.innerText('#impResult'), /أُضيف 2/);
      await shot('10-import');
      await page.click('#modalBody [data-close]');
      await page.waitForSelector(`#callTable td:has-text("CALL-${tag}1")`);
      await shot('11-calls');
      await noHScroll('calls');
      assert.equal((JSON.stringify(db._store.tables)).includes('مريض تجريبي'), false, 'patient name column ignored');

      await page.click(`#callTable tr:has-text("CALL-${tag}2") select`);
      await page.selectOption(`#callTable tr:has-text("CALL-${tag}2") select`, 'لم يرد');
      await page.waitForSelector(`#callTable tr:has-text("CALL-${tag}2") .pill:has-text("لم يرد")`);

      await page.click(`#callTable tr:has-text("CALL-${tag}1") [data-start]`);
      await page.waitForSelector('#callBanner:not(.hidden)');
      assert.equal(await page.inputValue('#exFile'), `CALL-${tag}1`);
      assert.equal(await page.inputValue('#exPhone'), '0551112233');
      assert.equal(await page.$eval('#chSeg input:checked', i => i.value), 'اتصال');
      await page.click('#vtSeg label:has-text("إجراء") >> nth=0');
      await page.click('[data-stars=bookingRating] label >> nth=3');
      await page.click('[data-stars=receptionRating] label >> nth=4');
      await page.click('#planSeg label:has-text("جزئياً")');
      await page.click('[data-stars=doctorRating] label >> nth=4');
      await page.click('#sentSeg label:has-text("إيجابية")');
      await page.waitForTimeout(350);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot('12-call-survey');
      await page.click('#exSave');
      await page.waitForSelector('#toast.on:not(.err)');
      assert.match(await page.innerText('#toast'), /إغلاق الاتصال/);
      assert.equal(await page.isHidden('#callBanner'), true);
      const call = db._store.tables.call_queue.find(c => c.file_no === `CALL-${tag}1`);
      assert.equal(call.status, 'تم');
      assert.equal(db._store.tables.experiences.find(e => e.id === call.experience_id).channel, 'اتصال');

      await page.click('#tabs button[data-tab=reviews]');
      await page.waitForSelector('#revSetup:not(.hidden) .setup');
      await shot('13-reviews-setup');
      await noHScroll('reviews');

      // Follow-up: the negative experience recorded above opened a case; handle it end to end.
      await page.click('#tabs button[data-tab=cases]');
      await page.waitForSelector('#caseList .case-card');
      await page.click('#caseView button[data-v=none]');
      await page.waitForSelector(`#caseList .case-card:has-text("وقت الانتظار")`);
      await shot('14-cases');
      await noHScroll('cases');
      await page.click(`#caseList .case-card:has-text("وقت الانتظار") >> nth=0`);
      await page.waitForSelector('#evForm');
      assert.equal(await page.locator('#csWa').count(), 1, 'WhatsApp button shown for a valid mobile');
      const wa = await page.getAttribute('#csWa', 'href');
      assert.match(wa, /^https:\/\/wa\.me\/9665\d{8}\?text=/);
      await page.selectOption('#evOut', 'تم التواصل');
      await page.fill('#evBody', 'اعتذرنا عن التأخير وشرحنا السبب');
      await page.click('#evForm button[type=submit]');
      await page.waitForSelector('.timeline li:has-text("تم التواصل")');
      await page.selectOption('#clReason', 'تم الاعتذار والتوضيح');
      await page.fill('#clRes', 'تم التواصل والاعتذار');
      await page.evaluate(() => document.querySelector('#clForm').scrollIntoView());
      await shot('15-case-detail');
      await page.click('#clForm button[type=submit]');
      await page.waitForSelector('.panel h3:has-text("الإقفال")');
      await page.click('#modalBody [data-close]');

      // Other roles see only their tabs.
      for (const [username, visible, hidden] of [
        ['officer', ['cases', 'calls', 'add'], ['kpi', 'admin']],
        ['ceo', ['cases', 'kpi', 'complaints'], ['add', 'calls', 'admin']],
        ['bm.b', ['cases', 'kpi', 'add'], ['admin']]
      ]) {
        const ctx2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: 'ar-SA', timezoneId: 'Asia/Riyadh' });
        const p2 = await ctx2.newPage();
        p2.on('pageerror', e => problems.push(`${username}: ${e.message}`));
        await p2.goto(base);
        await p2.fill('#lgUser', username); await p2.fill('#lgPass', 'Role-Pass-1');
        await p2.click('#loginForm button[type=submit]');
        await p2.waitForSelector('#appView:not(.hidden)');
        for (const t of visible) assert.equal(await p2.isVisible(`#tabs button[data-tab=${t}]`), true, `${username} sees ${t}`);
        for (const t of hidden) assert.equal(await p2.isVisible(`#tabs button[data-tab=${t}]`), false, `${username} must not see ${t}`);
        if (username === 'ceo') {
          await p2.waitForSelector('#caseList .case-card, #caseList .empty');
          await p2.click('#tabs button[data-tab=kpi]');
          await p2.waitForSelector('#kpiBody .chart-card h3:has-text("المتابعة")');
          await p2.screenshot({ path: path.join(OUT, `${vp.name}-16-kpis-ceo.png`), fullPage: true });
        }
        await ctx2.close();
      }

      assert.deepEqual(problems, [], `${vp.name}: console errors`);
      console.log(`✓ ${vp.name}`);
    } catch (e) {
      await shot('zz-failure').catch(() => {});
      failures.push(`${vp.name}: ${e.message}`);
      console.error(`✗ ${vp.name}: ${e.message}`);
    }
    await ctx.close();
  }

  await browser.close();
  server.close();
  if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
  console.log(`screenshots in ${OUT}`);
}

run().catch(e => { console.error(e); process.exit(1); });
