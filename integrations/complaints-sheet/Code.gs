/**
 * Apex Care — ربط شيت الشكاوى بنظام تجربة المريض
 *
 * يُلصق هذا الملف في شيت الشكاوى: الإضافات ← Apps Script.
 * ثم شغّل setup() مرة واحدة وأدخل:
 *   1) رابط الـ webhook:  https://<render-app>.onrender.com/api/webhooks/complaints
 *   2) قيمة WEBHOOK_SECRET من إعدادات الخدمة في Render
 *
 * يُرسَل فقط: رقم الملف، الجوال، الطبيب، الفرع، التصنيف، الخطورة، نص الشكوى، التاريخ والوقت.
 * الفرع: من عمود الفرع (بأي صيغة: بريدة / فرع بريدة / Buraydah…)، وإلا الفرع الافتراضي
 * للورقة من الإعداد، وإلا يستنتجه النظام من فرع الطبيب.
 * أي عمود آخر — وخاصة اسم المريض — لا يُقرأ ولا يُرسل أبداً.
 */

var BATCH_SIZE = 50;
var PROP_URL = 'WEBHOOK_URL';
var PROP_SECRET = 'WEBHOOK_SECRET';
var PROP_SHEET = 'SHEET_NAME';
var PROP_BRANCH = 'DEFAULT_BRANCH';

// Only these fields ever leave the sheet. A header matches when it CONTAINS one of the
// keywords (headers like "DATE OF EVENT\nتاريخ الحدث" or "Please provide your phone number…"
// work). Fields are matched in this order and a column is used once, so the most specific
// fields go first. Columns that look like a patient's name are never used.
var FIELDS = [
  ['date', ['تاريخ الحدث', 'date of event', 'event date', 'تاريخ الزيارة', 'visit date', 'تاريخ الشكوى', 'complaint date', 'التاريخ', 'تاريخ', 'date', 'الطابع الزمني', 'timestamp']],
  ['time', ['وقت الحدث', 'time of event', 'event time', 'وقت الزيارة', 'visit time', 'الوقت', 'وقت', 'time']],
  ['phone', ['رقم الجوال', 'الجوال', 'جوال', 'رقم الهاتف', 'هاتف', 'phone', 'mobile']],
  ['file_no', ['رقم الملف', 'رقم ملف', 'الملف', 'medical record', 'file', 'mrn']],
  ['doctor', ['اسم الطبيب', 'الطبيب', 'طبيب', 'doctor', 'dentist', 'physician']],
  ['branch', ['الفرع', 'فرع', 'branch']],
  ['severity', ['درجة الخطورة', 'الخطورة', 'severity', 'priority']],
  ['category', ['نوع الشكوى', 'تصنيف', 'category', 'complaint type', 'type of complaint']],
  ['description', ['تفاصيل الشكوى', 'نص الشكوى', 'وصف الشكوى', 'اكتب الشكوى', 'الشكوى', 'شكوى', 'التفاصيل', 'تفاصيل', 'الوصف', 'وصف',
    'describe', 'description', 'details', 'complaint', 'feedback', 'الملاحظات', 'ملاحظ']]
];
var NAME_COLUMN = /(اسم المريض|اسم المراجع|الاسم|اسمك|patient name|full name|your name|^name\b|\bname$)/;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ربط نظام تجربة المريض')
    .addItem('الإعداد (مرة واحدة)', 'setup')
    .addItem('إرسال الشكاوى الجديدة الآن', 'pushNewMenu')
    .addToUi();
}

function setup() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var url = ui.prompt('رابط الـ webhook', 'مثال: https://apexcare-patient-experience.onrender.com/api/webhooks/complaints', ui.ButtonSet.OK_CANCEL);
  if (url.getSelectedButton() !== ui.Button.OK) return;
  var secret = ui.prompt('السر المشترك', 'انسخ قيمة WEBHOOK_SECRET من Render ← Environment', ui.ButtonSet.OK_CANCEL);
  if (secret.getSelectedButton() !== ui.Button.OK) return;
  var u = url.getResponseText().trim();
  var s = secret.getResponseText().trim();
  if (!/^https:\/\/.+\/api\/webhooks\/complaints$/.test(u)) { ui.alert('الرابط يجب أن يبدأ بـ https:// وينتهي بـ /api/webhooks/complaints'); return; }
  if (!s) { ui.alert('السر مطلوب'); return; }
  var b = ui.prompt('فرع هذه الورقة (اختياري)',
    'إذا كانت كل شكاوى هذه الورقة لفرع واحد اكتب: بريدة أو عنيزة.\nاتركه فارغاً إذا كان في الورقة عمود للفرع أو فيها الفرعان.\n(إذا لم يُذكر الفرع يأخذه النظام من فرع الطبيب.)', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  var branch = b.getResponseText().trim();
  if (branch && ['بريدة', 'عنيزة'].indexOf(branch) < 0) { ui.alert('الفرع يكون «بريدة» أو «عنيزة» أو فارغاً'); return; }

  var sheet = SpreadsheetApp.getActiveSheet();
  props.setProperties({ WEBHOOK_URL: u, WEBHOOK_SECRET: s, SHEET_NAME: sheet.getName(), DEFAULT_BRANCH: branch });
  var cols = headerMap_(sheet);
  if (cols.description === undefined) {
    ui.alert('لم أجد عمود نص الشكوى في الورقة «' + sheet.getName() + '».\nافتح ورقة الشكاوى ثم شغّل الإعداد مرة أخرى.\n\nما وجدته:\n' + describeMapping_(sheet, cols));
    return;
  }

  // Replace any earlier triggers created by this script.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['onFormSubmitPush', 'pushNew'].indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t);
  });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var formNote = '';
  try {
    if (ss.getFormUrl()) {
      ScriptApp.newTrigger('onFormSubmitPush').forSpreadsheet(ss).onFormSubmit().create();
      formNote = '\n• إرسال فوري عند كل رد جديد على النموذج';
    }
  } catch (e) { /* no linked form */ }
  // Safety net: catches manual rows and anything a failed request left behind.
  ScriptApp.newTrigger('pushNew').timeBased().everyMinutes(15).create();

  var r = pushNew();
  ui.alert('الأعمدة المستخدمة:\n' + describeMapping_(sheet, cols) + '\n\nتم الإعداد على الورقة «' + sheet.getName() + '»' + (branch ? '\n• الفرع الافتراضي: ' + branch : '') + formNote + '\n• إرسال احتياطي كل 15 دقيقة\n\nأُرسل الآن: ' + r.sent + ' صف (جديد في النظام: ' + r.inserted + ')');
}

function onFormSubmitPush() { pushNew(); }

function pushNewMenu() {
  var r = pushNew();
  SpreadsheetApp.getUi().alert('أُرسل: ' + r.sent + ' صف · جديد في النظام: ' + r.inserted + (r.error ? '\nخطأ: ' + r.error : ''));
}

/**
 * Sends every row after the last successfully sent one, in batches.
 * The pointer only advances after the server confirms a batch, so a failed
 * request is retried next time and the server's upsert drops duplicates.
 */
function pushNew() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { sent: 0, inserted: 0, error: 'تشغيل آخر قيد التنفيذ' };
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty(PROP_URL), secret = props.getProperty(PROP_SECRET);
    if (!url || !secret) return { sent: 0, inserted: 0, error: 'شغّل الإعداد أولاً' };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(props.getProperty(PROP_SHEET)) || ss.getSheets()[0];
    var cols = headerMap_(sheet);
    if (cols.description === undefined) return { sent: 0, inserted: 0, error: 'لا يوجد عمود نص الشكوى' };

    var key = 'LAST_ROW:' + sheet.getSheetId();
    var lastSent = Number(props.getProperty(key) || 1); // row 1 = headers
    var lastRow = sheet.getLastRow();
    if (lastRow <= lastSent) return { sent: 0, inserted: 0 };

    var width = sheet.getLastColumn();
    var range = sheet.getRange(lastSent + 1, 1, lastRow - lastSent, width);
    var values = range.getValues();
    var shown = range.getDisplayValues();
    var tz = ss.getSpreadsheetTimeZone();
    var defaultBranch = props.getProperty(PROP_BRANCH) || '';
    var sent = 0, inserted = 0;

    for (var start = 0; start < values.length; start += BATCH_SIZE) {
      var chunk = values.slice(start, start + BATCH_SIZE);
      var rows = [];
      chunk.forEach(function (row, i) {
        var rowNumber = lastSent + 1 + start + i;
        var out = { source_key: ss.getId() + ':' + sheet.getName() + ':' + rowNumber };
        Object.keys(cols).forEach(function (field) {
          if (field !== 'date' && field !== 'time') out[field] = cell_(row[cols[field]], tz);
        });
        if (cols.date !== undefined) out.date = when_(row[cols.date], cols.time !== undefined ? shown[start + i][cols.time] : '', tz);
        if (!out.branch && defaultBranch) out.branch = defaultBranch;
        if (out.description) rows.push(out);
      });
      if (rows.length) {
        var res = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'X-Webhook-Secret': secret },
          payload: JSON.stringify({ rows: rows }),
          muteHttpExceptions: true
        });
        var code = res.getResponseCode();
        var body = {};
        try { body = JSON.parse(res.getContentText()); } catch (e) { /* non-JSON */ }
        if (code !== 200 || !body.ok) {
          // Stop without advancing: the next run retries from here.
          return { sent: sent, inserted: inserted, error: 'HTTP ' + code + ' ' + (body.error || '') };
        }
        inserted += body.inserted || 0;
        sent += rows.length;
      }
      props.setProperty(key, String(lastSent + start + chunk.length));
    }
    return { sent: sent, inserted: inserted };
  } finally {
    lock.releaseLock();
  }
}

function norm_(s) { return String(s || '').toLowerCase().replace(/[\u064B-\u0652]/g, '').replace(/\s+/g, ' ').trim(); }

/** field -> column index for a header row (array of strings). Pure, so it can be tested outside Apps Script. */
function matchHeaders_(headers) {
  var head = headers.map(norm_);
  var used = {}, map = {};
  FIELDS.forEach(function (f) {
    var field = f[0], keys = f[1].map(norm_);
    for (var k = 0; k < keys.length && map[field] === undefined; k++) {
      for (var i = 0; i < head.length; i++) {
        if (used[i] || !head[i] || head[i].indexOf(keys[k]) < 0) continue;
        if (NAME_COLUMN.test(head[i]) && !(field === 'doctor' && /طبيب|doctor/.test(head[i]))) continue;
        if (field === 'time' && /timestamp|الطابع الزمني/.test(head[i])) continue;
        map[field] = i; used[i] = true; break;
      }
    }
  });
  return map;
}

function headerMap_(sheet) {
  return matchHeaders_(sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0]);
}

/** 24h "HH:mm:ss" from "2:00:00 PM", "14:00", "9:15 م"…; '' if none. */
function time24_(text) {
  var m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|ص|م)?/i.exec(String(text || ''));
  if (!m) return '';
  var h = +m[1], ap = (m[4] || '').toLowerCase();
  if ((ap === 'pm' || ap === 'م') && h < 12) h += 12;
  if ((ap === 'am' || ap === 'ص') && h === 12) h = 0;
  return ('0' + h).slice(-2) + ':' + m[2] + ':' + (m[3] || '00');
}

/**
 * When the event happened, as ISO with the sheet's offset. The time comes from its own column
 * when there is one (read as displayed, to avoid Sheets' 1899 time-only dates).
 */
function when_(dateValue, timeDisplay, tz) {
  if (!(dateValue instanceof Date)) return String(dateValue || '').trim();
  var time = time24_(timeDisplay) || Utilities.formatDate(dateValue, tz, 'HH:mm:ss');
  return Utilities.formatDate(dateValue, tz, 'yyyy-MM-dd') + 'T' + time + Utilities.formatDate(dateValue, tz, 'XXX');
}

function cell_(v, tz) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v).trim();
}

/** Shows which sheet column feeds which field, so the mapping can be checked at a glance. */
function describeMapping_(sheet, cols) {
  var head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  var label = { file_no: 'رقم الملف', phone: 'الجوال', doctor: 'الطبيب', branch: 'الفرع', category: 'التصنيف', severity: 'الخطورة', description: 'نص الشكوى', date: 'التاريخ', time: 'الوقت' };
  return FIELDS.map(function (f) {
    var i = cols[f[0]];
    return '• ' + label[f[0]] + ': ' + (i === undefined ? '— غير موجود' : '«' + String(head[i]).replace(/\s+/g, ' ').slice(0, 40) + '»');
  }).join('\n');
}
