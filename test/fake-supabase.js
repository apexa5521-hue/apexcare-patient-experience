'use strict';

// In-memory stand-in for the subset of supabase-js the server uses.
// It mirrors supabase/schema.sql: same columns, defaults, unique keys and the
// generated visit_time_local column, and it rejects unknown columns like PostgREST does.

const crypto = require('node:crypto');
const { localParts } = require('../server/time');

const SCHEMA = {
  app_users: {
    cols: ['id', 'username', 'name', 'role', 'branch', 'password_hash', 'active', 'must_change', 'created_at', 'last_login'],
    unique: ['username'],
    defaults: () => ({ branch: null, active: true, must_change: true, created_at: new Date().toISOString(), last_login: null })
  },
  doctors: {
    cols: ['id', 'name', 'name_ar', 'specialty', 'branch', 'active'],
    unique: ['name'],
    defaults: () => ({ active: true })
  },
  categories: {
    cols: ['id', 'name', 'type', 'active'],
    unique: ['name'],
    defaults: () => ({ active: true })
  },
  experiences: {
    cols: ['id', 'created_at', 'visit_at', 'visit_time_local', 'file_no', 'phone', 'doctor_id', 'branch', 'specialty', 'visit_type',
      'sentiment', 'category', 'severity', 'follow_up', 'booking_rating', 'reception_rating', 'plan_explained', 'doctor_rating',
      'general_note', 'channel', 'created_by'],
    generated: ['visit_time_local'],
    unique: [],
    defaults: () => ({ created_at: new Date().toISOString(), channel: 'حضوري' }),
    compute: (r) => ({ visit_time_local: `${localParts(r.visit_at, 'Asia/Riyadh').time}:${String(localParts(r.visit_at, 'Asia/Riyadh').second).padStart(2, '0')}` })
  },
  complaints: {
    cols: ['id', 'created_at', 'file_no', 'phone', 'doctor_id', 'doctor_name_raw', 'branch', 'category', 'severity', 'status',
      'description', 'source', 'source_key', 'assigned_to', 'resolution', 'closed_at', 'updated_by'],
    unique: ['source_key'],
    defaults: () => ({ created_at: new Date().toISOString(), severity: 'متوسطة', status: 'جديدة' })
  },
  audit_log: {
    cols: ['id', 'at', 'username', 'action', 'details'],
    unique: [],
    serial: true,
    defaults: () => ({ at: new Date().toISOString() })
  },
  call_queue: {
    cols: ['id', 'created_at', 'visit_at', 'file_no', 'phone', 'doctor_id', 'doctor_name_raw', 'branch', 'status', 'attempts',
      'last_attempt_at', 'experience_id', 'updated_by'],
    unique: [['file_no', 'visit_at']],
    defaults: () => ({ created_at: new Date().toISOString(), status: 'بانتظار الاتصال', attempts: 0 })
  },
  google_reviews: {
    cols: ['id', 'location', 'branch', 'rating', 'comment', 'created_at', 'updated_at', 'reply', 'replied_at', 'status', 'note',
      'handled_by', 'fetched_at'],
    unique: ['id'],
    defaults: () => ({ status: 'جديد', fetched_at: new Date().toISOString() })
  },
  cases: {
    cols: ['id', 'created_at', 'updated_at', 'source', 'source_id', 'branch', 'doctor_id', 'file_no', 'phone', 'summary', 'category',
      'severity', 'status', 'assigned_to', 'due_at', 'first_response_at', 'close_reason', 'resolution', 'closed_at', 'closed_by', 'approved_by'],
    unique: [['source', 'source_id']],
    defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), severity: 'متوسطة', status: 'جديدة' })
  },
  case_events: {
    cols: ['id', 'case_id', 'at', 'username', 'type', 'outcome', 'body'],
    unique: [],
    serial: true,
    defaults: () => ({ at: new Date().toISOString() })
  },
  service_ratings: {
    cols: ['id', 'created_at', 'source_key', 'branch', 'visit_at', 'q_booking', 'q_reception', 'q_waiting', 'q_explanation', 'q_care',
      'q_recommend', 'q_overall', 'comment'],
    unique: ['source_key'],
    defaults: () => ({ created_at: new Date().toISOString() })
  },
  app_settings: {
    cols: ['key', 'value', 'updated_at'],
    unique: ['key'],
    noId: true,
    defaults: () => ({ updated_at: new Date().toISOString() })
  }
};

const DEFAULT_CATEGORIES = [
  ['وقت الانتظار', 'سلبية'], ['تأخر الموعد', 'سلبية'], ['أسلوب التعامل', 'سلبية'], ['عدم وضوح الشرح للمريض', 'سلبية'],
  ['الألم أثناء الإجراء', 'سلبية'], ['التكلفة والأسعار', 'سلبية'], ['النظافة والتعقيم', 'سلبية'], ['نتيجة العلاج', 'سلبية'],
  ['الاستقبال والحجز', 'سلبية'], ['أخرى', 'الكل'], ['حسن التعامل', 'إيجابية'], ['وضوح الشرح', 'إيجابية'],
  ['دقة وإتقان العمل', 'إيجابية'], ['الالتزام بالموعد', 'إيجابية']
];

const err = (message, code) => ({ data: null, error: { message, code }, count: null });

class Query {
  constructor(store, table) {
    this.store = store; this.table = table; this.spec = SCHEMA[table];
    this.action = 'select'; this.filters = []; this.orders = []; this.cols = null;
    this.countMode = null; this.head = false; this.singleMode = null; this.rangeArgs = null;
    if (!this.spec) throw new Error(`fake: unknown table ${table}`);
  }

  select(cols = '*', opts = {}) {
    if (this.action === 'select' || !this.cols) this.cols = cols;
    if (this.action === 'select') { this.countMode = opts.count || null; this.head = !!opts.head; }
    this.returning = this.action !== 'select';
    return this;
  }
  insert(rows) { this.action = 'insert'; this.payload = [].concat(rows); return this; }
  upsert(rows, opts = {}) { this.action = 'upsert'; this.payload = [].concat(rows); this.upsertOpts = opts; return this; }
  update(patch) { this.action = 'update'; this.payload = patch; return this; }

  _f(op, col, val) { this.filters.push({ op, col, val }); return this; }
  eq(c, v) { return this._f('eq', c, v); }
  neq(c, v) { return this._f('neq', c, v); }
  gt(c, v) { return this._f('gt', c, v); }
  gte(c, v) { return this._f('gte', c, v); }
  lt(c, v) { return this._f('lt', c, v); }
  lte(c, v) { return this._f('lte', c, v); }
  ilike(c, v) { return this._f('ilike', c, v); }
  in(c, v) { return this._f('in', c, v); }

  order(col, { ascending = true } = {}) { this.orders.push({ col, ascending }); return this; }
  range(a, b) { this.rangeArgs = [a, b]; return this; }
  limit(n) { this.rangeArgs = [0, n - 1]; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  single() { this.singleMode = 'one'; return this; }

  then(resolve, reject) { return Promise.resolve().then(() => this._run()).then(resolve, reject); }

  _checkCols(obj) {
    for (const k of Object.keys(obj)) {
      if (!this.spec.cols.includes(k)) return `Could not find the '${k}' column of '${this.table}'`;
      if ((this.spec.generated || []).includes(k)) return `cannot insert into generated column ${k}`;
    }
    return null;
  }

  _match(row) {
    return this.filters.every(({ op, col, val }) => {
      if (!this.spec.cols.includes(col)) throw Object.assign(new Error(`column ${col} does not exist`), { code: '42703' });
      const v = row[col];
      switch (op) {
        case 'eq': return v === val || (v !== null && v !== undefined && String(v) === String(val));
        case 'neq': return v !== null && v !== undefined && String(v) !== String(val);
        case 'gt': return v !== null && v !== undefined && v > val;
        case 'gte': return v !== null && v !== undefined && v >= val;
        case 'lt': return v !== null && v !== undefined && v < val;
        case 'lte': return v !== null && v !== undefined && v <= val;
        case 'in': return val.includes(v);
        case 'ilike': {
          const re = new RegExp('^' + String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
          return v !== null && v !== undefined && re.test(String(v));
        }
        default: throw new Error(`fake: op ${op}`);
      }
    });
  }

  _project(row) {
    if (!this.cols || this.cols === '*') return { ...row };
    const out = {};
    for (const c of this.cols.split(',').map(s => s.trim())) {
      if (!this.spec.cols.includes(c)) throw Object.assign(new Error(`column ${this.table}.${c} does not exist`), { code: '42703' });
      out[c] = row[c] === undefined ? null : row[c];
    }
    return out;
  }

  _materialize(input) {
    const row = {};
    for (const c of this.spec.cols) row[c] = null;
    Object.assign(row, this.spec.defaults(), input);
    if (!this.spec.noId && !row.id) row.id = this.spec.serial ? ++this.store.serial : crypto.randomUUID();
    if (this.spec.compute) Object.assign(row, this.spec.compute(row));
    return row;
  }

  /** First unique key (a column, or an array of columns) that `row` would duplicate; nulls never clash. */
  _conflict(row, rows) {
    const same = (r, k) => [].concat(k).every(c => row[c] !== null && row[c] !== undefined && r[c] === row[c]);
    const key = this.spec.unique.find(k => rows.some(r => r !== row && same(r, k)));
    return key === undefined ? undefined : [].concat(key).join(',');
  }

  _finish(rows) {
    let data = rows.map(r => this._project(r));
    if (this.singleMode) {
      if (data.length > 1) return err('multiple rows returned', 'PGRST116');
      if (!data.length) return this.singleMode === 'one' ? err('no rows returned', 'PGRST116') : { data: null, error: null, count: null };
      return { data: data[0], error: null, count: null };
    }
    return { data, error: null, count: null };
  }

  _run() {
    const rows = this.store.tables[this.table];
    try {
      if (this.action === 'insert' || this.action === 'upsert') {
        const created = [], merged = [];
        for (const input of this.payload) {
          const bad = this._checkCols(input);
          if (bad) return err(bad, 'PGRST204');
          const row = this._materialize(input);
          const clash = this._conflict(row, [...rows, ...created]);
          if (clash) {
            const upsertKey = this.action === 'upsert' && clash === this.upsertOpts.onConflict;
            if (upsertKey && this.upsertOpts.ignoreDuplicates) continue;
            if (upsertKey) {
              // ON CONFLICT DO UPDATE: only the columns sent are overwritten.
              const cols = clash.split(',');
              const existing = rows.find(r => cols.every(c => r[c] === row[c]));
              Object.assign(existing, input);
              merged.push(existing);
              continue;
            }
            return err(`duplicate key value violates unique constraint "${this.table}_${clash}_key"`, '23505');
          }
          created.push(row);
        }
        rows.push(...created);
        return this.returning ? this._finish([...created, ...merged]) : { data: null, error: null, count: null };
      }
      if (this.action === 'update') {
        const bad = this._checkCols(this.payload);
        if (bad) return err(bad, 'PGRST204');
        const hit = rows.filter(r => this._match(r));
        for (const r of hit) {
          const next = { ...r, ...this.payload };
          if (this._conflict(next, rows.filter(x => x !== r))) return err('duplicate key value violates unique constraint', '23505');
        }
        for (const r of hit) {
          Object.assign(r, this.payload);
          if (this.spec.compute) Object.assign(r, this.spec.compute(r));
        }
        return this.returning ? this._finish(hit) : { data: null, error: null, count: null };
      }
      let out = rows.filter(r => this._match(r));
      const count = this.countMode ? out.length : null;
      if (this.orders.length) {
        out = [...out].sort((a, b) => {
          for (const { col, ascending } of this.orders) {
            const x = a[col], y = b[col];
            if (x === y) continue;
            if (x === null || x === undefined) return 1;
            if (y === null || y === undefined) return -1;
            return (x < y ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
      }
      if (this.rangeArgs) out = out.slice(this.rangeArgs[0], this.rangeArgs[1] + 1);
      if (this.head) return { data: null, error: null, count };
      const res = this._finish(out);
      if (!res.error) res.count = count;
      return res;
    } catch (e) {
      return err(e.message, e.code || 'XX000');
    }
  }
}

function createFakeSupabase() {
  const store = { serial: 0, tables: Object.fromEntries(Object.keys(SCHEMA).map(t => [t, []])) };
  for (const [name, type] of DEFAULT_CATEGORIES) {
    store.tables.categories.push({ id: crypto.randomUUID(), name, type, active: true });
  }
  return { from: (table) => new Query(store, table), _store: store, _schema: SCHEMA };
}

module.exports = { createFakeSupabase, SCHEMA };
