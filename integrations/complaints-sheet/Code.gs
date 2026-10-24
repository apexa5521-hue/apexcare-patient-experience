/**
 * Apex Care — ربط شيتات الباركود (الشكاوى وتقييم الخدمة) بنظام تجربة المريض
 *
 * يُلصق هذا الملف في شيت الشكاوى: الإضافات ← Apps Script.
 * افتح ورقة الشكاوى ثم شغّل setup() وأدخل:
 *   1) رابط الـ webhook:  https://<render-app>.onrender.com/api/webhooks/complaints
 *   2) قيمة WEBHOOK_SECRET من إعدادات الخدمة في Render
 *   3) فرع الورقة (اختياري)
 * لربط ورقة ثانية (ورقة لكل فرع، أو ورقة تقييم الخدمة): افتحها وشغّل setup() مرة أخرى.
 * نوع الورقة (شكاوى أو تقييم خدمة) يُعرف تلقائياً من عناوين الأعمدة.
 * الرابط نفسه يُستخدم للنوعين (…/api/webhooks/complaints)، والسكربت يرسل كل نوع لمساره.
 *
 * يُرسَل فقط: رقم الملف، الجوال، الطبيب، الفرع، التصنيف، الخطورة، نص الشكوى، التاريخ والوقت.
 * الفرع: من عمود الفرع (بأي صيغة: بريدة / فرع بريدة / Buraydah…)، وإلا فرع الورقة من الإعداد،
 * وإلا يستنتجه النظام من فرع الطبيب.
 * أي عمود آخر — وخاصة اسم المريض — لا يُقرأ ولا يُرسل أبداً.
 */

var BATCH_SIZE = 50;
var PROP_URL = 'WEBHOOK_URL';
var PROP_SECRET = 'WEBHOOK_SECRET';
var PROP_SHEETS = 'SHEETS'; // JSON [{ id, name, branch }]

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
// Service-rating QR survey. Answers are sent as written; the server scores them 1–5.
var RATING_FIELDS = [
  ['visit_date', ['date of visit', 'تاريخ الزيارة', 'visit date']],
  ['visit_time', ['time of visit', 'وقت الزيارة', 'visit time']],
  ['date', ['الطابع الزمني', 'timestamp']],
  ['branch', ['الفرع', 'فرع', 'branch']],
  ['q_booking', ['schedule my appointment', 'تحديد موعدي', 'حجز الموعد', 'الحجز']],
  ['q_reception', ['greeted', 'استقبلت', 'الاستقبال', 'reception']],
  ['q_waiting', ['waiting time', 'وقت الانتظار', 'الانتظار']],
  ['q_explanation', ['explained my diagnosis', 'شرح لي الطبيب', 'شرح الطبيب', 'explained']],
  ['q_overall', ['overall satisfaction', 'الرضا العام']],
  ['q_care', ['satisfied with the care', 'راض عن الرعاية', 'الرعاية التي تلقيتها']],
  ['q_recommend', ['recommend', 'أوصي', 'اوصي']],
  ['comment', ['comment', 'ملاحظات', 'تعليق', 'اقتراح']]
];
var RATING_LABELS = { visit_date: 'تاريخ الزيارة', visit_time: 'وقت الزيارة', date: 'وقت التعبئة', branch: 'الفرع', q_booking: 'سهولة الحجز',
  q_reception: 'الاستقبال', q_waiting: 'وقت الانتظار', q_explanation: 'شرح الطبيب', q_overall: 'الرضا العام', q_care: 'الرضا عن الرعاية',
  q_recommend: 'التوصية بالمركز', comment: 'تعليق' };
var COMPLAINT_LABELS = { file_no: 'رقم الملف', phone: 'الجوال', doctor: 'الطبيب', branch: 'الفرع', category: 'التصنيف', severity: 'الخطورة',
  description: 'نص الشكوى', date: 'التاريخ', time: 'الوقت' };

var NAME_COLUMN = /(اسم المريض|اسم المراجع|الاسم|اسمك|patient name|full name|your name|^name\b|\bname$)/;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ربط نظام تجربة المريض')
    .addItem('ربط هذه الورقة (الإعداد)', 'setup')
    .addItem('إرسال الشكاوى الجديدة الآن', 'pushNewMenu')
    .addItem('إلغاء ربط هذه الورقة', 'unlinkSheet')
    .addToUi();
}

/** Linked sheets; upgrades the single-sheet settings of the first version. */
function linkedSheets_(props) {
  var raw = props.getProperty(PROP_SHEETS);
  if (raw) { try { return JSON.parse(raw); } catch (e) { return []; } }
  var oldName = props.getProperty('SHEET_NAME');
  if (!oldName) return [];
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(oldName);
  return sh ? [{ id: sh.getSheetId(), name: oldName, branch: props.getProperty('DEFAULT_BRANCH') || '' }] : [];
}

function sheetById_(ss, id) {
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (all[i].getSheetId() === id) return all[i];
  return null;
}

function setup() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var savedUrl = props.getProperty(PROP_URL), savedSecret = props.getProperty(PROP_SECRET);
  var keep = '\n(اتركه فارغاً لاستخدام القيمة المحفوظة)';

  var url = ui.prompt('رابط الـ webhook', 'مثال: https://apexcare-patient-experience.onrender.com/api/webhooks/complaints' + (savedUrl ? keep : ''), ui.ButtonSet.OK_CANCEL);
  if (url.getSelectedButton() !== ui.Button.OK) return;
  var u = url.getResponseText().trim() || savedUrl || '';
  if (!/^https:\/\/.+\/api\/webhooks\/complaints$/.test(u)) { ui.alert('الرابط يجب أن يبدأ بـ https:// وينتهي بـ /api/webhooks/complaints'); return; }

  var secret = ui.prompt('السر المشترك', 'انسخ قيمة WEBHOOK_SECRET من Render ← Environment' + (savedSecret ? keep : ''), ui.ButtonSet.OK_CANCEL);
  if (secret.getSelectedButton() !== ui.Button.OK) return;
  var s = secret.getResponseText().trim() || savedSecret || '';
  if (!s) { ui.alert('السر مطلوب'); return; }

  var sheet = SpreadsheetApp.getActiveSheet();
  var type = sheetType_(headers_(sheet));
  var cols = headerMap_(sheet, type);
  if (type === 'complaints' && cols.description === undefined) {
    ui.alert('لم أجد عمود نص الشكوى ولا أسئلة تقييم الخدمة في الورقة «' + sheet.getName() + '».\nافتح الورقة الصحيحة ثم شغّل الإعداد مرة أخرى.\n\nما وجدته:\n' + describeMapping_(sheet, cols, type));
    return;
  }

  var b = ui.prompt('فرع الورقة «' + sheet.getName() + '» (اختياري)',
    'إذا كانت كل شكاوى هذه الورقة لفرع واحد اكتب: بريدة أو عنيزة.\nاتركه فارغاً إذا كان في الورقة عمود للفرع أو فيها الفرعان.\n(إذا لم يُذكر الفرع يأخذه النظام من فرع الطبيب.)', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  var branch = b.getResponseText().trim();
  if (branch && ['بريدة', 'عنيزة'].indexOf(branch) < 0) { ui.alert('الفرع يكون «بريدة» أو «عنيزة» أو فارغاً'); return; }

  var sheets = linkedSheets_(props).filter(function (x) { return x.id !== sheet.getSheetId(); });
  sheets.push({ id: sheet.getSheetId(), name: sheet.getName(), branch: branch, type: type });
  props.setProperties({ WEBHOOK_URL: u, WEBHOOK_SECRET: s, SHEETS: JSON.stringify(sheets) });
  props.deleteProperty('SHEET_NAME');
  props.deleteProperty('DEFAULT_BRANCH');

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
  ui.alert('نوع الورقة: ' + (type === 'ratings' ? 'تقييم الخدمة' : 'شكاوى') + '\nالأعمدة المستخدمة في «' + sheet.getName() + '»:\n' + describeMapping_(sheet, cols, type) +
    '\n\nالأوراق المربوطة:\n' + sheets.map(function (x) { return '• ' + x.name + ' (' + (x.type === 'ratings' ? 'تقييم خدمة' : 'شكاوى') + ')' + (x.branch ? ' — ' + x.branch : ''); }).join('\n') +
    formNote + '\n• إرسال احتياطي كل 15 دقيقة' +
    '\n\nأُرسل الآن: ' + r.sent + ' صف (جديد في النظام: ' + r.inserted + ')' + (r.error ? '\nخطأ: ' + r.error : ''));
}

function unlinkSheet() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var sheet = SpreadsheetApp.getActiveSheet();
  var sheets = linkedSheets_(props);
  var rest = sheets.filter(function (x) { return x.id !== sheet.getSheetId(); });
  if (rest.length === sheets.length) { ui.alert('الورقة «' + sheet.getName() + '» غير مربوطة'); return; }
  props.setProperty(PROP_SHEETS, JSON.stringify(rest));
  ui.alert('أُلغي ربط «' + sheet.getName() + '». الشكاوى المرسلة سابقاً تبقى في النظام.');
}

function onFormSubmitPush() { pushNew(); }

function pushNewMenu() {
  var r = pushNew();
  SpreadsheetApp.getUi().alert('أُرسل: ' + r.sent + ' صف · جديد في النظام: ' + r.inserted + (r.error ? '\nخطأ: ' + r.error : ''));
}

/** Pushes new rows from every linked sheet. */
function pushNew() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { sent: 0, inserted: 0, error: 'تشغيل آخر قيد التنفيذ' };
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty(PROP_URL), secret = props.getProperty(PROP_SECRET);
    if (!url || !secret) return { sent: 0, inserted: 0, error: 'شغّل الإعداد أولاً' };
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var total = { sent: 0, inserted: 0 }, errors = [];
    linkedSheets_(props).forEach(function (cfg) {
      var sheet = sheetById_(ss, cfg.id);
      if (!sheet) { errors.push('ورقة محذوفة: ' + cfg.name); return; }
      var r = pushSheet_(ss, sheet, cfg, url, secret, props);
      total.sent += r.sent; total.inserted += r.inserted;
      if (r.error) errors.push(sheet.getName() + ': ' + r.error);
    });
    if (errors.length) total.error = errors.join(' | ');
    return total;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sends every row after the last successfully sent one, in batches.
 * The pointer only advances after the server confirms a batch, so a failed
 * request is retried next time and the server's upsert drops duplicates.
 */
function pushSheet_(ss, sheet, cfg, url, secret, props) {
  var type = cfg.type || 'complaints';
  var defaultBranch = cfg.branch || '';
  var cols = headerMap_(sheet, type);
  if (type === 'complaints' && cols.description === undefined) return { sent: 0, inserted: 0, error: 'لا يوجد عمود نص الشكوى' };
  var endpoint = url.replace(/\/complaints$/, '/' + type);

  var key = 'LAST_ROW:' + sheet.getSheetId();
  var lastSent = Number(props.getProperty(key) || 1); // row 1 = headers
  var lastRow = sheet.getLastRow();
  if (lastRow <= lastSent) return { sent: 0, inserted: 0 };

  var width = sheet.getLastColumn();
  var range = sheet.getRange(lastSent + 1, 1, lastRow - lastSent, width);
  var values = range.getValues();
  var shown = range.getDisplayValues();
  var tz = ss.getSpreadsheetTimeZone();
  var sent = 0, inserted = 0;

  for (var start = 0; start < values.length; start += BATCH_SIZE) {
    var chunk = values.slice(start, start + BATCH_SIZE);
    var rows = [];
    chunk.forEach(function (row, i) {
      var rowNumber = lastSent + 1 + start + i;
      var out = type === 'ratings' ? ratingRow_(row, shown[start + i], cols, tz) : complaintRow_(row, shown[start + i], cols, tz);
      out.source_key = ss.getId() + ':' + sheet.getName() + ':' + rowNumber;
      if (!out.branch && defaultBranch) out.branch = defaultBranch;
      if (hasContent_(out, type)) rows.push(out);
    });
    if (rows.length) {
      var res = UrlFetchApp.fetch(endpoint, {
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
}

function complaintRow_(row, shownRow, cols, tz) {
  var out = {};
  Object.keys(cols).forEach(function (field) {
    if (field !== 'date' && field !== 'time') out[field] = cell_(row[cols[field]], tz);
  });
  if (cols.date !== undefined) out.date = when_(row[cols.date], cols.time !== undefined ? shownRow[cols.time] : '', tz);
  return out;
}

/** Answers are sent as displayed text; dates as ISO. */
function ratingRow_(row, shownRow, cols, tz) {
  var out = {};
  Object.keys(cols).forEach(function (field) {
    if (field === 'date' || field === 'visit_date' || field === 'visit_time') return;
    out[field] = String(shownRow[cols[field]] || '').trim();
  });
  if (cols.date !== undefined) out.date = when_(row[cols.date], '', tz);
  if (cols.visit_date !== undefined) out.visit_date = when_(row[cols.visit_date], cols.visit_time !== undefined ? shownRow[cols.visit_time] : '', tz);
  return out;
}

function hasContent_(out, type) {
  if (type === 'complaints') return !!out.description;
  return Object.keys(out).some(function (k) { return k.indexOf('q_') === 0 && out[k]; });
}

function headers_(sheet) {
  return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
}

/** "ratings" when at least three service-rating questions are present, else "complaints". */
function sheetType_(headers) {
  var m = matchHeaders_(headers, RATING_FIELDS);
  var questions = Object.keys(m).filter(function (k) { return k.indexOf('q_') === 0; }).length;
  return questions >= 3 ? 'ratings' : 'complaints';
}

function norm_(s) { return String(s || '').toLowerCase().replace(/[\u064B-\u0652]/g, '').replace(/\s+/g, ' ').trim(); }

/** field -> column index for a header row (array of strings). Pure, so it can be tested outside Apps Script. */
function matchHeaders_(headers, fields) {
  var head = headers.map(norm_);
  var used = {}, map = {};
  (fields || FIELDS).forEach(function (f) {
    var field = f[0], keys = f[1].map(norm_);
    for (var k = 0; k < keys.length && map[field] === undefined; k++) {
      for (var i = 0; i < head.length; i++) {
        if (used[i] || !head[i] || head[i].indexOf(keys[k]) < 0) continue;
        if (NAME_COLUMN.test(head[i]) && !(field === 'doctor' && /طبيب|doctor/.test(head[i]))) continue;
        if ((field === 'time' || field === 'visit_time') && /timestamp|الطابع الزمني/.test(head[i])) continue;
        map[field] = i; used[i] = true; break;
      }
    }
  });
  return map;
}

function headerMap_(sheet, type) {
  return matchHeaders_(headers_(sheet), type === 'ratings' ? RATING_FIELDS : FIELDS);
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
function describeMapping_(sheet, cols, type) {
  var head = headers_(sheet);
  var label = type === 'ratings' ? RATING_LABELS : COMPLAINT_LABELS;
  return (type === 'ratings' ? RATING_FIELDS : FIELDS).map(function (f) {
    var i = cols[f[0]];
    return '• ' + label[f[0]] + ': ' + (i === undefined ? '— غير موجود' : '«' + String(head[i]).replace(/\s+/g, ' ').slice(0, 40) + '»');
  }).join('\n');
}
