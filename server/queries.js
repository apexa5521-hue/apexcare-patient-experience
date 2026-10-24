'use strict';

// Query builders and row mappers shared by the list, export and KPI routes.

const { localToUtc, addDays, formatLocal } = require('./time');
const { UserError, maskPhone } = require('./validate');

function dateBounds(q, col, f, tz) {
  if (f.from && f.to && f.from > f.to) throw new UserError('تاريخ البداية بعد تاريخ النهاية');
  if (f.from) q = q.gte(col, localToUtc(f.from, '00:00', tz).toISOString());
  if (f.to) q = q.lt(col, localToUtc(addDays(f.to, 1), '00:00', tz).toISOString());
  return q;
}

function applyExperienceFilters(q, f, tz) {
  q = dateBounds(q, 'visit_at', f, tz);
  if (f.timeFrom && f.timeTo && f.timeFrom > f.timeTo) throw new UserError('وقت البداية بعد وقت النهاية');
  if (f.timeFrom) q = q.gte('visit_time_local', `${f.timeFrom}:00`);
  if (f.timeTo) q = q.lte('visit_time_local', `${f.timeTo}:59`);
  if (f.branch) q = q.eq('branch', f.branch);
  if (f.doctorId) q = q.eq('doctor_id', f.doctorId);
  if (f.sentiment) q = q.eq('sentiment', f.sentiment);
  if (f.visitType) q = q.eq('visit_type', f.visitType);
  if (f.fileNo) q = q.ilike('file_no', `%${f.fileNo}%`);
  return q;
}

function applyComplaintFilters(q, f, tz) {
  q = dateBounds(q, 'created_at', f, tz);
  if (f.status) q = q.eq('status', f.status);
  if (f.branch) q = q.eq('branch', f.branch);
  if (f.doctorId) q = q.eq('doctor_id', f.doctorId);
  if (f.fileNo) q = q.ilike('file_no', `%${f.fileNo}%`);
  return q;
}

function mapExperience(e, { admin, tz, doctorNames, usernames }) {
  return {
    id: e.id,
    visitAt: formatLocal(e.visit_at, tz),
    fileNo: e.file_no,
    phone: admin ? e.phone || '' : maskPhone(e.phone),
    doctorId: e.doctor_id,
    doctor: doctorNames.get(e.doctor_id) || '',
    branch: e.branch,
    specialty: e.specialty,
    visitType: e.visit_type,
    bookingRating: e.booking_rating,
    receptionRating: e.reception_rating,
    planExplained: e.plan_explained,
    doctorRating: e.doctor_rating,
    sentiment: e.sentiment,
    category: e.category || '',
    severity: e.severity || '',
    followUp: e.follow_up || '',
    generalNote: e.general_note || '',
    by: admin ? usernames.get(e.created_by) || '' : undefined
  };
}

function mapComplaint(c, { admin, tz, doctorNames, overdue }) {
  return {
    id: c.id,
    createdAt: formatLocal(c.created_at, tz),
    fileNo: c.file_no || '',
    phone: admin ? c.phone || '' : maskPhone(c.phone),
    doctorId: c.doctor_id,
    doctor: (c.doctor_id && doctorNames.get(c.doctor_id)) || c.doctor_name_raw || '',
    branch: c.branch || '',
    category: c.category || '',
    severity: c.severity,
    status: c.status,
    description: c.description,
    source: c.source,
    assignedTo: c.assigned_to || '',
    resolution: c.resolution || '',
    closedAt: formatLocal(c.closed_at, tz),
    overdue
  };
}

module.exports = { applyExperienceFilters, applyComplaintFilters, mapExperience, mapComplaint };
