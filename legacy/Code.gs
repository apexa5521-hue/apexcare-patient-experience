/**
 * نظام تجربة المريض - Apex Care
 * الخلفية: Google Apps Script + Google Sheets
 * يعمل كـ Web App (Execute as: Me / Access: Anyone) وتستدعيه الواجهة عبر POST.
 */

var TZ = 'Asia/Riyadh';
var BRANCHES = ['بريدة', 'عنيزة'];
var SPECIALTIES = ['أسنان', 'جلدية'];
var VISIT_TYPES = ['كشف', 'إجراء', 'كشف وإجراء'];
var SENTIMENTS = ['إيجابية', 'سلبية', 'محايدة'];
var SEVERITIES = ['بسيطة', 'متوسطة', 'عالية'];
var STATUSES = ['جديدة', 'قيد المعالجة', 'مغلقة'];
var ROLES = ['staff', 'admin'];
var SESSION_SECONDS = 21600; // 6 ساعات (الحد الأقصى للكاش)
var OVERDUE_DAYS = 3;

var HEADERS = {
  Users: ['Username', 'Name', 'Role', 'Branch', 'PasswordHash', 'Salt', 'Active', 'MustChange', 'CreatedAt', 'LastLogin'],
  Doctors: ['Name', 'Specialty', 'Branch', 'Active'],
  Categories: ['Name', 'Type', 'Active'],
  Experiences: ['ID', 'CreatedAt', 'VisitDateTime', 'FileNo', 'Phone', 'Doctor', 'Branch', 'Specialty', 'VisitType', 'Sentiment', 'Category', 'Severity', 'FollowUp', 'Note', 'CreatedBy'],
  Complaints: ['ID', 'CreatedAt', 'FileNo', 'Phone', 'Doctor', 'Branch', 'Category', 'Severity', 'Status', 'Description', 'Source', 'AssignedTo', 'ClosedAt', 'Resolution', 'SourceKey', 'UpdatedBy'],
  Audit: ['Time', 'User', 'Action', 'Details'],
  Settings: ['Key', 'Value']
};

var DEFAULT_CATEGORIES = [
  ['وقت الانتظار', 'سلبية'], ['تأخر الموعد', 'سلبية'], ['أسلوب التعامل', 'سلبية'],
  ['عدم وضوح الشرح للمريض', 'سلبية'], ['الألم أثناء الإجراء', 'سلبية'], ['التكلفة والأسعار', 'سلبية'],
  ['النظافة والتعقيم', 'سلبية'], ['نتيجة العلاج', 'سلبية'], ['الاستقبال والحجز', 'سلبية'], ['أخرى', 'الكل'],
  ['حسن التعامل', 'إيجابية'], ['وضوح الشرح', 'إيجابية'], ['دقة وإتقان العمل', 'إيجابية'], ['الالتزام بالموعد', 'إيجابية']
];

/* ====================== القائمة والإعداد ====================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('نظام تجربة المريض')
    .addItem('إعداد النظام (مرة واحدة)', 'setup')
    .addItem('مزامنة الشكاوى الآن', 'syncComplaintsMenu')
    .addItem('تفعيل المزامنة التلقائية (كل ساعة)', 'installSyncTrigger')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SSID', ss.getId());
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var h = HEADERS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (['Experiences', 'Complaints', 'Users', 'Doctors', 'Categories'].indexOf(name) > -1) {
      sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), h.length).setNumberFormat('@');
    }
  });
  // حماية أوراق الحسابات والتدقيق من التعديل اليدوي غير المقصود
  ['Users', 'Audit'].forEach(function (n) {
    var p = ss.getSheetByName(n).protect().setDescription('محمية - تُدار من النظام');
    p.setWarningOnly(true);
  });

  var cats = read_('Categories');
  if (!cats.length) {
    DEFAULT_CATEGORIES.forEach(function (c) { append_('Categories', { Name: c[0], Type: c[1], Active: 'TRUE' }); });
  }
  var msg = 'تم إعداد الأوراق. أضف الأطباء في ورقة Doctors أو من لوحة الإدارة.';
  if (!read_('Users').length) {
    var pw = randomPassword_();
    var salt = Utilities.getUuid();
    append_('Users', {
      Username: 'admin', Name: 'مدير النظام', Role: 'admin', Branch: '',
      PasswordHash: hash_(pw, salt), Salt: salt, Active: 'TRUE', MustChange: 'TRUE',
      CreatedAt: now_(), LastLogin: ''
    });
    msg += '\nحساب الإدارة: admin\nكلمة المرور المؤقتة: ' + pw + '\n(سيُطلب تغييرها عند أول دخول)';
  }
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* التشغيل من المحرر */ }
}

function syncComplaintsMenu() {
  var n = syncComplaints_();
  try { SpreadsheetApp.getUi().alert('تمت المزامنة. شكاوى جديدة: ' + n); } catch (e) { Logger.log('new complaints: ' + n); }
}

function installSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncComplaintsTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncComplaintsTrigger').timeBased().everyHours(1).create();
  Logger.log('تم تفعيل المزامنة التلقائية كل ساعة');
}

function syncComplaintsTrigger() { syncComplaints_(); }

/* ====================== نقطة الدخول ====================== */

function doGet() {
  return json_({ ok: true, service: 'patient-experience', time: now_() });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: (err && err.userMessage) ? err.message : 'حدث خطأ غير متوقع' };
    if (!(err && err.userMessage)) Logger.log(err && err.stack ? err.stack : err);
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(msg) {
  var e = new Error(msg);
  e.userMessage = true;
  throw e;
}

function route_(req) {
  var a = req.action, d = req.data || {};
  if (a === 'login') return login_(d);
  var user = auth_(req.token);
  var admin = user.Role === 'admin';
  switch (a) {
    case 'me': return { ok: true, user: pubUser_(user) };
    case 'logout': CacheService.getScriptCache().remove('t_' + req.token); return { ok: true };
    case 'changePassword': return changePassword_(user, d);
  }
  if (user.MustChange === 'TRUE') fail_('يجب تغيير كلمة المرور أولاً');
  switch (a) {
    case 'lookups': return { ok: true, lookups: lookups_() };
    case 'addExperience': return addExperience_(user, d);
    case 'listExperiences': return listExperiences_(user, d);
    case 'listComplaints': return listComplaints_(user, d);
    case 'addComplaint': return addComplaint_(user, d);
  }
  if (!admin) fail_('لا تملك صلاحية لهذا الإجراء');
  switch (a) {
    case 'updateComplaint': return updateComplaint_(user, d);
    case 'kpis': return { ok: true, kpis: kpis_(d) };
    case 'updateExperience': return updateExperience_(user, d);
    case 'listUsers': return listUsers_();
    case 'saveUser': return saveUser_(user, d);
    case 'saveDoctor': return saveDoctor_(user, d);
    case 'saveCategory': return saveCategory_(user, d);
    case 'getSettings': return { ok: true, settings: { ComplaintsSourceId: getSetting_('ComplaintsSourceId'), ComplaintsSourceSheet: getSetting_('ComplaintsSourceSheet') } };
    case 'saveSettings':
      setSetting_('ComplaintsSourceId', String(d.ComplaintsSourceId || '').trim());
      setSetting_('ComplaintsSourceSheet', String(d.ComplaintsSourceSheet || '').trim());
      log_(user.Username, 'saveSettings', 'complaints source');
      return { ok: true };
    case 'syncComplaints':
      var n = syncComplaints_();
      log_(user.Username, 'syncComplaints', 'new=' + n);
      return { ok: true, added: n };
  }
  fail_('إجراء غير معروف');
}

/* ====================== المصادقة ====================== */

function hash_(pw, salt) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8);
  return d.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function randomPassword_() {
  var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 10; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function pubUser_(u) {
  return { username: u.Username, name: u.Name, role: u.Role, branch: u.Branch, mustChange: u.MustChange === 'TRUE' };
}

function login_(d) {
  var username = String(d.username || '').trim().toLowerCase();
  var pw = String(d.password || '');
  if (!username || !pw) fail_('أدخل اسم المستخدم وكلمة المرور');
  var cache = CacheService.getScriptCache();
  var key = 'f_' + username;
  var fails = Number(cache.get(key) || 0);
  if (fails >= 5) fail_('تم إيقاف المحاولات مؤقتاً. حاول بعد 10 دقائق');
  var u = findUser_(username);
  if (!u || u.Active !== 'TRUE' || hash_(pw, u.Salt) !== u.PasswordHash) {
    cache.put(key, String(fails + 1), 600);
    log_(username, 'login_failed', '');
    fail_('اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  cache.remove(key);
  var token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('t_' + token, u.Username, SESSION_SECONDS);
  setCell_('Users', u._row, 'LastLogin', now_());
  log_(u.Username, 'login', '');
  return { ok: true, token: token, user: pubUser_(u) };
}

function auth_(token) {
  if (!token) fail_('انتهت الجلسة، سجّل الدخول من جديد');
  var username = CacheService.getScriptCache().get('t_' + token);
  if (!username) fail_('انتهت الجلسة، سجّل الدخول من جديد');
  var u = findUser_(username);
  if (!u || u.Active !== 'TRUE') fail_('الحساب غير مفعّل');
  return u;
}

function changePassword_(user, d) {
  var oldPw = String(d.oldPassword || ''), newPw = String(d.newPassword || '');
  if (hash_(oldPw, user.Salt) !== user.PasswordHash) fail_('كلمة المرور الحالية غير صحيحة');
  if (newPw.length < 8) fail_('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
  if (newPw === oldPw) fail_('اختر كلمة مرور مختلفة عن الحالية');
  var salt = Utilities.getUuid();
  setCell_('Users', user._row, 'Salt', salt);
  setCell_('Users', user._row, 'PasswordHash', hash_(newPw, salt));
  setCell_('Users', user._row, 'MustChange', 'FALSE');
  log_(user.Username, 'changePassword', '');
  return { ok: true };
}

function findUser_(username) {
  var rows = read_('Users');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Username).toLowerCase() === String(username).toLowerCase()) return rows[i];
  }
  return null;
}

/* ====================== الجداول والمساعدات ====================== */

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SSID');
  if (!id) fail_('النظام غير مهيّأ. شغّل إعداد النظام من قائمة الشيت');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) fail_('ورقة غير موجودة: ' + name);
  return sh;
}

function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

function cellStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
  return v === null || v === undefined ? '' : String(v);
}

function read_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var h = HEADERS[name];
  var vals = sh.getRange(2, 1, last - 1, h.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (vals[i].every(function (c) { return c === '' || c === null; })) continue;
    var o = { _row: i + 2 };
    for (var j = 0; j < h.length; j++) o[h[j]] = cellStr_(vals[i][j]);
    out.push(o);
  }
  return out;
}

function append_(name, obj) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(name);
    var h = HEADERS[name];
    var row = h.map(function (k) { return obj[k] === undefined || obj[k] === null ? '' : obj[k]; });
    var r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, h.length).setNumberFormat('@').setValues([row]);
    return r;
  } finally { lock.releaseLock(); }
}

function setCell_(name, row, col, val) {
  var idx = HEADERS[name].indexOf(col);
  sheet_(name).getRange(row, idx + 1).setNumberFormat('@').setValue(val);
}

function log_(user, action, details) {
  try { append_('Audit', { Time: now_(), User: user, Action: action, Details: String(details || '').slice(0, 300) }); } catch (e) { }
}

function getSetting_(k) {
  var rows = read_('Settings');
  for (var i = 0; i < rows.length; i++) if (rows[i].Key === k) return rows[i].Value;
  return '';
}

function setSetting_(k, v) {
  var rows = read_('Settings');
  for (var i = 0; i < rows.length; i++) if (rows[i].Key === k) { setCell_('Settings', rows[i]._row, 'Value', v); return; }
  append_('Settings', { Key: k, Value: v });
}

function newId_(p) { return p + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(); }

function cleanFile_(v) {
  var s = String(v || '').trim();
  if (!/^[A-Za-z0-9\-\/]{1,20}$/.test(s)) fail_('رقم الملف غير صالح (أرقام وحروف إنجليزية فقط، حتى 20 خانة)');
  return s;
}

function normPhone_(v) {
  var s = String(v || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  s = s.replace(/^\+/, '').replace(/^00/, '');
  if (s.indexOf('966') === 0) s = s.slice(3);
  if (s.charAt(0) !== '0') s = '0' + s;
  if (!/^05\d{8}$/.test(s)) fail_('رقم الجوال غير صالح (مثال: 05XXXXXXXX)');
  return s;
}

function maskPhone_(p) { return p && p.length >= 6 ? p.slice(0, 2) + '*****' + p.slice(-3) : ''; }

function oneOf_(v, list, label) {
  if (list.indexOf(v) < 0) fail_('قيمة غير صالحة: ' + label);
  return v;
}

function lookups_() {
  var docs = read_('Doctors').filter(function (r) { return r.Active === 'TRUE'; })
    .map(function (r) { return { name: r.Name, specialty: r.Specialty, branch: r.Branch }; });
  var cats = read_('Categories').filter(function (r) { return r.Active === 'TRUE'; })
    .map(function (r) { return { name: r.Name, type: r.Type }; });
  return { doctors: docs, categories: cats, branches: BRANCHES, specialties: SPECIALTIES, visitTypes: VISIT_TYPES, sentiments: SENTIMENTS, severities: SEVERITIES, statuses: STATUSES };
}

function findDoctor_(name) {
  var rows = read_('Doctors');
  for (var i = 0; i < rows.length; i++) if (rows[i].Name === name && rows[i].Active === 'TRUE') return rows[i];
  return null;
}

/* ====================== التجارب ====================== */

function addExperience_(user, d) {
  var fileNo = cleanFile_(d.fileNo);
  var phone = normPhone_(d.phone);
  var branch = oneOf_(d.branch, BRANCHES, 'الفرع');
  var doc = findDoctor_(d.doctor);
  if (!doc) fail_('اختر الطبيب من القائمة');
  var vt = oneOf_(d.visitType, VISIT_TYPES, 'نوع الزيارة');
  var sent = oneOf_(d.sentiment, SENTIMENTS, 'التجربة');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.visitDate || '')) fail_('تاريخ الزيارة غير صالح');
  if (!/^\d{2}:\d{2}$/.test(d.visitTime || '')) fail_('وقت الزيارة غير صالح');
  var category = String(d.category || '').trim();
  var severity = '';
  if (sent === 'سلبية') {
    if (!category) fail_('اختر تصنيف المشكلة للتجربة السلبية');
    severity = oneOf_(d.severity || 'بسيطة', SEVERITIES, 'درجة الخطورة');
  }
  var note = String(d.note || '').trim().slice(0, 1000);
  var id = newId_('EX');
  append_('Experiences', {
    ID: id, CreatedAt: now_(), VisitDateTime: d.visitDate + ' ' + d.visitTime, FileNo: fileNo, Phone: phone,
    Doctor: doc.Name, Branch: branch, Specialty: doc.Specialty, VisitType: vt, Sentiment: sent,
    Category: category, Severity: severity, FollowUp: sent === 'سلبية' ? 'جديدة' : '', Note: note, CreatedBy: user.Username
  });
  log_(user.Username, 'addExperience', id);
  return { ok: true, id: id };
}

function inRange_(dt, f) {
  var date = dt.slice(0, 10), time = dt.slice(11, 16);
  if (f.from && date < f.from) return false;
  if (f.to && date > f.to) return false;
  if (f.timeFrom && time < f.timeFrom) return false;
  if (f.timeTo && time > f.timeTo) return false;
  return true;
}

function filterEx_(rows, f) {
  return rows.filter(function (r) {
    if (!inRange_(r.VisitDateTime, f)) return false;
    if (f.branch && r.Branch !== f.branch) return false;
    if (f.doctor && r.Doctor !== f.doctor) return false;
    if (f.sentiment && r.Sentiment !== f.sentiment) return false;
    if (f.visitType && r.VisitType !== f.visitType) return false;
    if (f.fileNo && r.FileNo.indexOf(String(f.fileNo).trim()) < 0) return false;
    return true;
  });
}

function listExperiences_(user, f) {
  var admin = user.Role === 'admin';
  var rows = filterEx_(read_('Experiences'), f || {});
  if (!admin) rows = rows.filter(function (r) { return r.CreatedBy === user.Username; });
  rows.sort(function (a, b) { return a.VisitDateTime < b.VisitDateTime ? 1 : -1; });
  var total = rows.length;
  rows = rows.slice(0, 500).map(function (r) {
    return {
      id: r.ID, visit: r.VisitDateTime, fileNo: r.FileNo, phone: admin ? r.Phone : maskPhone_(r.Phone),
      doctor: r.Doctor, branch: r.Branch, specialty: r.Specialty, visitType: r.VisitType, sentiment: r.Sentiment,
      category: r.Category, severity: r.Severity, followUp: r.FollowUp, note: r.Note, by: admin ? r.CreatedBy : ''
    };
  });
  return { ok: true, total: total, rows: rows };
}

function updateExperience_(user, d) {
  var rows = read_('Experiences');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ID === d.id) {
      if (rows[i].Sentiment !== 'سلبية') fail_('المتابعة للتجارب السلبية فقط');
      setCell_('Experiences', rows[i]._row, 'FollowUp', oneOf_(d.followUp, STATUSES, 'الحالة'));
      log_(user.Username, 'updateExperience', d.id + ' -> ' + d.followUp);
      return { ok: true };
    }
  }
  fail_('السجل غير موجود');
}

/* ====================== الشكاوى ====================== */

function mapComplaint_(r, admin) {
  return {
    id: r.ID, createdAt: r.CreatedAt, fileNo: r.FileNo, phone: admin ? r.Phone : maskPhone_(r.Phone),
    doctor: r.Doctor, branch: r.Branch, category: r.Category, severity: r.Severity, status: r.Status,
    description: r.Description, source: r.Source, assignedTo: r.AssignedTo, closedAt: r.ClosedAt, resolution: r.Resolution,
    overdue: r.Status !== 'مغلقة' && daysSince_(r.CreatedAt) > OVERDUE_DAYS
  };
}

function daysSince_(dt) {
  var t = parseDt_(dt);
  return t ? (Date.now() - t.getTime()) / 86400000 : 0;
}

function parseDt_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}

function listComplaints_(user, f) {
  f = f || {};
  var admin = user.Role === 'admin';
  var rows = read_('Complaints').filter(function (r) {
    var date = r.CreatedAt.slice(0, 10);
    if (f.from && date < f.from) return false;
    if (f.to && date > f.to) return false;
    if (f.status && r.Status !== f.status) return false;
    if (f.branch && r.Branch !== f.branch) return false;
    if (f.doctor && r.Doctor !== f.doctor) return false;
    if (f.fileNo && r.FileNo.indexOf(String(f.fileNo).trim()) < 0) return false;
    return true;
  });
  rows.sort(function (a, b) { return a.CreatedAt < b.CreatedAt ? 1 : -1; });
  var all = read_('Complaints');
  var summary = {
    total: all.length,
    open: all.filter(function (r) { return r.Status !== 'مغلقة'; }).length,
    overdue: all.filter(function (r) { return r.Status !== 'مغلقة' && daysSince_(r.CreatedAt) > OVERDUE_DAYS; }).length
  };
  return { ok: true, summary: summary, total: rows.length, rows: rows.slice(0, 500).map(function (r) { return mapComplaint_(r, admin); }) };
}

function addComplaint_(user, d) {
  var desc = String(d.description || '').trim().slice(0, 2000);
  if (!desc) fail_('اكتب تفاصيل الشكوى');
  var doctor = String(d.doctor || '').trim();
  if (doctor && !findDoctor_(doctor)) fail_('الطبيب غير موجود في القائمة');
  var id = newId_('CP');
  append_('Complaints', {
    ID: id, CreatedAt: now_(), FileNo: cleanFile_(d.fileNo), Phone: normPhone_(d.phone), Doctor: doctor,
    Branch: oneOf_(d.branch, BRANCHES, 'الفرع'), Category: String(d.category || '').trim(),
    Severity: oneOf_(d.severity || 'متوسطة', SEVERITIES, 'درجة الخطورة'), Status: 'جديدة', Description: desc,
    Source: 'إدخال يدوي', AssignedTo: '', ClosedAt: '', Resolution: '', SourceKey: '', UpdatedBy: user.Username
  });
  log_(user.Username, 'addComplaint', id);
  return { ok: true, id: id };
}

function updateComplaint_(user, d) {
  var rows = read_('Complaints');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].ID === d.id) {
      var r = rows[i];
      var status = oneOf_(d.status, STATUSES, 'الحالة');
      setCell_('Complaints', r._row, 'Status', status);
      setCell_('Complaints', r._row, 'Resolution', String(d.resolution || '').trim().slice(0, 1000));
      setCell_('Complaints', r._row, 'AssignedTo', String(d.assignedTo || '').trim().slice(0, 80));
      setCell_('Complaints', r._row, 'ClosedAt', status === 'مغلقة' ? (r.ClosedAt || now_()) : '');
      setCell_('Complaints', r._row, 'UpdatedBy', user.Username);
      log_(user.Username, 'updateComplaint', d.id + ' -> ' + status);
      return { ok: true };
    }
  }
  fail_('الشكوى غير موجودة');
}

/**
 * مزامنة شيت شكاوى خارجي إلى ورقة Complaints.
 * يُقرأ الشيت بحسب أسماء الأعمدة (عربي/إنجليزي). أي عمود فيه اسم المريض لا يُنسخ إطلاقاً.
 */
var ALIASES = {
  fileNo: ['رقم الملف', 'رقم ملف المريض', 'رقم الملف الطبي', 'file', 'file no', 'fileno', 'file number', 'mrn'],
  phone: ['الجوال', 'رقم الجوال', 'جوال', 'phone', 'mobile'],
  doctor: ['الطبيب', 'اسم الطبيب', 'doctor'],
  branch: ['الفرع', 'branch'],
  category: ['التصنيف', 'نوع الشكوى', 'category', 'type'],
  severity: ['الخطورة', 'درجة الخطورة', 'severity'],
  description: ['الشكوى', 'تفاصيل الشكوى', 'نص الشكوى', 'الوصف', 'الملاحظات', 'complaint', 'description', 'details'],
  date: ['التاريخ', 'تاريخ الشكوى', 'الطابع الزمني', 'timestamp', 'date'],
  status: ['الحالة', 'status']
};

function norm_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function syncComplaints_() {
  var srcId = getSetting_('ComplaintsSourceId');
  if (!srcId) return 0;
  var srcSs = SpreadsheetApp.openById(srcId);
  var shName = getSetting_('ComplaintsSourceSheet');
  var sh = shName ? srcSs.getSheetByName(shName) : srcSs.getSheets()[0];
  if (!sh) fail_('ورقة المصدر غير موجودة');
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return 0;
  var head = vals[0].map(norm_);
  var col = {};
  Object.keys(ALIASES).forEach(function (k) {
    for (var i = 0; i < head.length; i++) {
      if (ALIASES[k].map(norm_).indexOf(head[i]) > -1) { col[k] = i; break; }
    }
  });
  if (col.description === undefined) fail_('لم أجد عمود نص الشكوى في الشيت المصدر');
  var existing = {};
  read_('Complaints').forEach(function (r) { if (r.SourceKey) existing[r.SourceKey] = true; });
  var added = 0;
  for (var r = 1; r < vals.length; r++) {
    var key = srcId.slice(-6) + ':' + (shName || 'first') + ':' + (r + 1);
    if (existing[key]) continue;
    var row = vals[r];
    var desc = col.description !== undefined ? cellStr_(row[col.description]).trim() : '';
    if (!desc) continue;
    var get = function (k) { return col[k] !== undefined ? cellStr_(row[col[k]]).trim() : ''; };
    var phone = '';
    try { phone = normPhone_(get('phone')); } catch (e) { phone = ''; }
    var status = get('status');
    if (STATUSES.indexOf(status) < 0) status = 'جديدة';
    var sev = get('severity');
    if (SEVERITIES.indexOf(sev) < 0) sev = 'متوسطة';
    var branch = get('branch');
    if (BRANCHES.indexOf(branch) < 0) branch = '';
    append_('Complaints', {
      ID: newId_('CP'), CreatedAt: get('date') || now_(), FileNo: get('fileNo'), Phone: phone, Doctor: get('doctor'),
      Branch: branch, Category: get('category'), Severity: sev, Status: status, Description: desc.slice(0, 2000),
      Source: 'شيت الشكاوى', AssignedTo: '', ClosedAt: '', Resolution: '', SourceKey: key, UpdatedBy: 'sync'
    });
    added++;
  }
  return added;
}

/* ====================== مؤشرات الأداء ====================== */

function kpis_(f) {
  f = f || {};
  var ex = filterEx_(read_('Experiences'), f);
  var co = read_('Complaints').filter(function (r) {
    var date = r.CreatedAt.slice(0, 10);
    if (f.from && date < f.from) return false;
    if (f.to && date > f.to) return false;
    if (f.branch && r.Branch !== f.branch) return false;
    if (f.doctor && r.Doctor !== f.doctor) return false;
    return true;
  });

  var summary = { total: ex.length, pos: 0, neg: 0, neu: 0, complaints: co.length, openComplaints: 0, overdue: 0, avgCloseHours: null };
  var docs = {};
  function doc_(n, spec) {
    if (!docs[n]) docs[n] = { name: n, specialty: spec || '', total: 0, pos: 0, neg: 0, neu: 0, complaints: 0, high: 0, closeSum: 0, closeN: 0 };
    return docs[n];
  }
  read_('Doctors').forEach(function (r) { if (r.Active === 'TRUE' && (!f.doctor || f.doctor === r.Name)) doc_(r.Name, r.Specialty); });

  var cats = {}, hours = [], wd = [], months = {}, years = {}, heat = [];
  for (var h = 0; h < 24; h++) hours.push({ total: 0, neg: 0 });
  for (var w = 0; w < 7; w++) { wd.push({ total: 0, neg: 0 }); heat.push(new Array(24).fill(0)); }

  ex.forEach(function (r) {
    var s = r.Sentiment;
    var key = s === 'إيجابية' ? 'pos' : s === 'سلبية' ? 'neg' : 'neu';
    summary[key]++;
    var d = doc_(r.Doctor, r.Specialty);
    d.total++; d[key]++;
    if (key === 'neg' && r.Severity === 'عالية') d.high++;
    if (key === 'neg' && r.Category) { cats[r.Category] = cats[r.Category] || { name: r.Category, ex: 0, co: 0 }; cats[r.Category].ex++; }
    var t = parseDt_(r.VisitDateTime);
    if (!t) return;
    var hr = t.getHours(), dow = t.getDay();
    var isNeg = key === 'neg' ? 1 : 0;
    hours[hr].total++; hours[hr].neg += isNeg;
    wd[dow].total++; wd[dow].neg += isNeg;
    if (isNeg) heat[dow][hr]++;
    var mk = r.VisitDateTime.slice(0, 7), yk = r.VisitDateTime.slice(0, 4);
    months[mk] = months[mk] || { total: 0, neg: 0 }; months[mk].total++; months[mk].neg += isNeg;
    years[yk] = years[yk] || { total: 0, neg: 0 }; years[yk].total++; years[yk].neg += isNeg;
  });

  var closeSum = 0, closeN = 0;
  co.forEach(function (r) {
    if (r.Status !== 'مغلقة') {
      summary.openComplaints++;
      if (daysSince_(r.CreatedAt) > OVERDUE_DAYS) summary.overdue++;
    }
    if (r.Doctor) {
      var d = doc_(r.Doctor, '');
      d.complaints++;
      if (r.Status === 'مغلقة' && r.ClosedAt) {
        var a = parseDt_(r.CreatedAt), b = parseDt_(r.ClosedAt);
        if (a && b && b >= a) { var hrs = (b - a) / 3600000; d.closeSum += hrs; d.closeN++; closeSum += hrs; closeN++; }
      }
    } else if (r.Status === 'مغلقة' && r.ClosedAt) {
      var a2 = parseDt_(r.CreatedAt), b2 = parseDt_(r.ClosedAt);
      if (a2 && b2 && b2 >= a2) { closeSum += (b2 - a2) / 3600000; closeN++; }
    }
    if (r.Category) { cats[r.Category] = cats[r.Category] || { name: r.Category, ex: 0, co: 0 }; cats[r.Category].co++; }
  });
  summary.avgCloseHours = closeN ? Math.round(closeSum / closeN * 10) / 10 : null;

  var doctors = Object.keys(docs).map(function (n) {
    var d = docs[n];
    return {
      name: d.name, specialty: d.specialty, total: d.total, pos: d.pos, neg: d.neg, neu: d.neu,
      posRate: d.total ? Math.round(d.pos / d.total * 100) : null,
      negRate: d.total ? Math.round(d.neg / d.total * 100) : null,
      score: d.total ? Math.round((d.pos - d.neg) / d.total * 100) : null,
      complaints: d.complaints, high: d.high,
      avgCloseHours: d.closeN ? Math.round(d.closeSum / d.closeN * 10) / 10 : null
    };
  }).sort(function (a, b) { return (b.score === null ? -999 : b.score) - (a.score === null ? -999 : a.score); });

  var topProblems = Object.keys(cats).map(function (k) {
    return { name: k, ex: cats[k].ex, co: cats[k].co, count: cats[k].ex + cats[k].co };
  }).sort(function (a, b) { return b.count - a.count; }).slice(0, 10);

  function sortedObj(o) { return Object.keys(o).sort().map(function (k) { return { key: k, total: o[k].total, neg: o[k].neg }; }); }

  return { summary: summary, doctors: doctors, topProblems: topProblems, byHour: hours, byWeekday: wd, byMonth: sortedObj(months), byYear: sortedObj(years), heat: heat };
}

/* ====================== الإدارة ====================== */

function listUsers_() {
  return {
    ok: true,
    users: read_('Users').map(function (u) {
      return { username: u.Username, name: u.Name, role: u.Role, branch: u.Branch, active: u.Active === 'TRUE', lastLogin: u.LastLogin };
    }),
    doctors: read_('Doctors').map(function (r) { return { name: r.Name, specialty: r.Specialty, branch: r.Branch, active: r.Active === 'TRUE' }; }),
    categories: read_('Categories').map(function (r) { return { name: r.Name, type: r.Type, active: r.Active === 'TRUE' }; })
  };
}

function saveUser_(admin, d) {
  var username = String(d.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) fail_('اسم المستخدم: 3-30 حرفاً إنجليزياً أو أرقاماً');
  var name = String(d.name || '').trim().slice(0, 80);
  if (!name) fail_('أدخل الاسم');
  var role = oneOf_(d.role, ROLES, 'الدور');
  var branch = d.branch ? oneOf_(d.branch, BRANCHES, 'الفرع') : '';
  var active = d.active === false ? 'FALSE' : 'TRUE';
  var u = findUser_(username);
  var temp = null;
  if (u) {
    if (u.Username === admin.Username && (active === 'FALSE' || role !== 'admin')) fail_('لا يمكنك تعطيل حسابك أو تخفيض صلاحيتك');
    setCell_('Users', u._row, 'Name', name);
    setCell_('Users', u._row, 'Role', role);
    setCell_('Users', u._row, 'Branch', branch);
    setCell_('Users', u._row, 'Active', active);
    if (d.resetPassword) {
      temp = randomPassword_();
      var salt = Utilities.getUuid();
      setCell_('Users', u._row, 'Salt', salt);
      setCell_('Users', u._row, 'PasswordHash', hash_(temp, salt));
      setCell_('Users', u._row, 'MustChange', 'TRUE');
    }
  } else {
    temp = randomPassword_();
    var s2 = Utilities.getUuid();
    append_('Users', { Username: username, Name: name, Role: role, Branch: branch, PasswordHash: hash_(temp, s2), Salt: s2, Active: active, MustChange: 'TRUE', CreatedAt: now_(), LastLogin: '' });
  }
  log_(admin.Username, 'saveUser', username + (temp ? ' (password set)' : ''));
  return { ok: true, tempPassword: temp };
}

function saveDoctor_(admin, d) {
  var name = String(d.name || '').trim().slice(0, 80);
  if (!name) fail_('أدخل اسم الطبيب');
  var spec = oneOf_(d.specialty, SPECIALTIES, 'التخصص');
  var branch = d.branch === 'الكل' ? 'الكل' : oneOf_(d.branch, BRANCHES, 'الفرع');
  var active = d.active === false ? 'FALSE' : 'TRUE';
  var rows = read_('Doctors');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Name === name) {
      setCell_('Doctors', rows[i]._row, 'Specialty', spec);
      setCell_('Doctors', rows[i]._row, 'Branch', branch);
      setCell_('Doctors', rows[i]._row, 'Active', active);
      log_(admin.Username, 'saveDoctor', name);
      return { ok: true };
    }
  }
  append_('Doctors', { Name: name, Specialty: spec, Branch: branch, Active: active });
  log_(admin.Username, 'addDoctor', name);
  return { ok: true };
}

function saveCategory_(admin, d) {
  var name = String(d.name || '').trim().slice(0, 80);
  if (!name) fail_('أدخل اسم التصنيف');
  var type = oneOf_(d.type, ['سلبية', 'إيجابية', 'الكل'], 'النوع');
  var active = d.active === false ? 'FALSE' : 'TRUE';
  var rows = read_('Categories');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Name === name) {
      setCell_('Categories', rows[i]._row, 'Type', type);
      setCell_('Categories', rows[i]._row, 'Active', active);
      log_(admin.Username, 'saveCategory', name);
      return { ok: true };
    }
  }
  append_('Categories', { Name: name, Type: type, Active: active });
  log_(admin.Username, 'addCategory', name);
  return { ok: true };
}
