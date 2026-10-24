/**
 * Apex Care — ربط شيت الشكاوى بنظام تجربة المريض
 *
 * يُلصق هذا الملف في شيت الشكاوى: الإضافات ← Apps Script.
 * ثم شغّل setup() مرة واحدة وأدخل:
 *   1) رابط الـ webhook:  https://<render-app>.onrender.com/api/webhooks/complaints
 *   2) قيمة WEBHOOK_SECRET من إعدادات الخدمة في Render
 *
 * يُرسَل فقط: رقم الملف، الجوال، الطبيب، الفرع، التصنيف، الخطورة، نص الشكوى، التاريخ.
 * أي عمود آخر — وخاصة اسم المريض — لا يُقرأ ولا يُرسل أبداً.
 */

var BATCH_SIZE = 50;
var PROP_URL = 'WEBHOOK_URL';
var PROP_SECRET = 'WEBHOOK_SECRET';
var PROP_SHEET = 'SHEET_NAME';

// Only these fields ever leave the sheet. Headers are matched case/space-insensitively.
var ALIASES = {
  file_no: ['رقم الملف', 'رقم ملف المريض', 'file', 'file no', 'mrn'],
  phone: ['الجوال', 'رقم الجوال', 'phone', 'mobile'],
  doctor: ['الطبيب', 'اسم الطبيب', 'doctor'],
  branch: ['الفرع', 'branch'],
  category: ['التصنيف', 'نوع الشكوى', 'category'],
  severity: ['الخطورة', 'درجة الخطورة', 'severity'],
  description: ['الشكوى', 'تفاصيل الشكوى', 'نص الشكوى', 'الوصف', 'complaint', 'description'],
  date: ['التاريخ', 'تاريخ الشكوى', 'الطابع الزمني', 'timestamp', 'date']
};

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

  var sheet = SpreadsheetApp.getActiveSheet();
  props.setProperties({ WEBHOOK_URL: u, WEBHOOK_SECRET: s, SHEET_NAME: sheet.getName() });
  if (headerMap_(sheet).description === undefined) {
    ui.alert('لم أجد عمود نص الشكوى في الورقة «' + sheet.getName() + '». افتح ورقة الشكاوى ثم شغّل الإعداد مرة أخرى.');
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
  ui.alert('تم الإعداد على الورقة «' + sheet.getName() + '»' + formNote + '\n• إرسال احتياطي كل 15 دقيقة\n\nأُرسل الآن: ' + r.sent + ' صف (جديد في النظام: ' + r.inserted + ')');
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
    var values = sheet.getRange(lastSent + 1, 1, lastRow - lastSent, width).getValues();
    var tz = ss.getSpreadsheetTimeZone();
    var sent = 0, inserted = 0;

    for (var start = 0; start < values.length; start += BATCH_SIZE) {
      var chunk = values.slice(start, start + BATCH_SIZE);
      var rows = [];
      chunk.forEach(function (row, i) {
        var rowNumber = lastSent + 1 + start + i;
        var out = { source_key: ss.getId() + ':' + sheet.getName() + ':' + rowNumber };
        Object.keys(cols).forEach(function (field) { out[field] = cell_(row[cols[field]], field, tz); });
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

function norm_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

/** field -> column index, from the header row. Only aliased fields are mapped. */
function headerMap_(sheet) {
  var head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(norm_);
  var map = {};
  Object.keys(ALIASES).forEach(function (field) {
    var names = ALIASES[field].map(norm_);
    for (var i = 0; i < head.length; i++) {
      if (names.indexOf(head[i]) > -1) { map[field] = i; break; }
    }
  });
  return map;
}

function cell_(v, field, tz) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return field === 'date' ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v).trim();
}
