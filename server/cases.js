'use strict';

// Follow-up cases. Every complaint, negative experience, low service rating and low Google
// review opens one case; the case is where contact, notes, assignment and closing happen.
// The source record's own status field mirrors the case so older screens stay consistent.

const { must } = require('./db');

const SOURCES = ['شكوى', 'تجربة سلبية', 'تقييم خدمة', 'تقييم قوقل'];
const CASE_STATUSES = ['جديدة', 'قيد المعالجة', 'بانتظار المريض', 'بانتظار الاعتماد', 'مغلقة'];
const OPEN_STATUSES = CASE_STATUSES.filter(s => s !== 'مغلقة');
const CLOSE_REASONS = ['تم الحل', 'تم الاعتذار والتوضيح', 'إجراء تصحيحي / تعويض', 'تعذّر التواصل', 'غير مبررة', 'مكررة'];
const CONTACT_OUTCOMES = ['تم التواصل', 'لم يرد', 'مشغول / مغلق', 'رقم خاطئ', 'طلب معاودة الاتصال', 'أُرسلت رسالة'];
const SLA_HOURS = { 'عالية': 24, 'متوسطة': 48, 'بسيطة': 72 };
const SEVERITIES = Object.keys(SLA_HOURS);

function dueAt(createdAt, severity) {
  const hours = SLA_HOURS[severity] || SLA_HOURS['متوسطة'];
  return new Date(new Date(createdAt || Date.now()).getTime() + hours * 3600000).toISOString();
}

/**
 * Opens cases for new source records; an existing (source, source_id) is left untouched.
 * items: { source, source_id, created_at?, branch, doctor_id, file_no, phone, summary, category, severity }
 */
async function openCases(db, items) {
  if (!items.length) return [];
  const rows = items.map(i => {
    const severity = SEVERITIES.includes(i.severity) ? i.severity : 'متوسطة';
    const created = i.created_at || new Date().toISOString();
    return {
      source: i.source, source_id: String(i.source_id), created_at: created, updated_at: new Date().toISOString(),
      branch: i.branch || null, doctor_id: i.doctor_id || null, file_no: i.file_no || null, phone: i.phone || null,
      summary: i.summary ? String(i.summary).slice(0, 2000) : null, category: i.category || null,
      severity, status: 'جديدة', due_at: dueAt(created, severity)
    };
  });
  const opened = await must(db.from('cases').upsert(rows, { onConflict: 'source,source_id', ignoreDuplicates: true }).select('id,source'));
  if (opened.length) {
    await must(db.from('case_events').insert(opened.map(c => ({ case_id: c.id, username: 'النظام', type: 'نظام', body: `فُتحت تلقائياً من: ${c.source}` }))));
  }
  return opened;
}

async function addEvent(db, caseId, username, type, { outcome = null, body = null } = {}) {
  await must(db.from('case_events').insert({ case_id: caseId, username, type, outcome, body: body ? String(body).slice(0, 2000) : null }));
}

const mirrorStatus = (s) => (s === 'مغلقة' ? 'مغلقة' : s === 'جديدة' ? 'جديدة' : 'قيد المعالجة');

/** Keeps the source record's own follow-up fields in step with the case. */
async function syncSource(db, c, assigneeName) {
  if (c.source === 'شكوى') {
    await must(db.from('complaints').update({
      status: mirrorStatus(c.status), resolution: c.resolution || null, closed_at: c.closed_at || null,
      assigned_to: assigneeName || null, updated_by: c.closed_by || null
    }).eq('id', c.source_id));
  } else if (c.source === 'تجربة سلبية') {
    await must(db.from('experiences').update({ follow_up: mirrorStatus(c.status) }).eq('id', c.source_id));
  } else if (c.source === 'تقييم قوقل') {
    await must(db.from('google_reviews').update({ status: c.status === 'مغلقة' ? 'تمت المراجعة' : 'جديد' }).eq('id', c.source_id));
  }
}

/** source_id -> case id, for linking list rows to their case. */
async function caseIdsFor(db, source, ids) {
  if (!ids.length) return new Map();
  const rows = await must(db.from('cases').select('id,source_id').eq('source', source).in('source_id', ids.map(String)));
  return new Map(rows.map(r => [r.source_id, r.id]));
}

module.exports = {
  caseIdsFor,
  SOURCES, CASE_STATUSES, OPEN_STATUSES, CLOSE_REASONS, CONTACT_OUTCOMES, SLA_HOURS,
  dueAt, openCases, addEvent, syncSource
};
