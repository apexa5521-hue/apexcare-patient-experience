'use strict';

const { createClient } = require('@supabase/supabase-js');

/** Server-only Supabase client (service role bypasses RLS). Never expose this key to the browser. */
function createSupabase(url, serviceKey) {
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(normalizeSupabaseUrl(url), serviceKey.trim(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

/**
 * Accept the project URL however it was copied: Supabase's Data API page shows it with
 * /rest/v1, which supabase-js would append a second time (PostgREST error PGRST125).
 */
function normalizeSupabaseUrl(url) {
  return String(url).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

/** Unwrap a supabase-js result, throwing on error. */
async function must(promise) {
  const { data, error, count } = await promise;
  if (error) {
    const e = new Error(`db: ${error.message || error.code || 'error'}`);
    e.code = error.code;
    throw e;
  }
  return count === undefined || count === null ? data : { data, count };
}

/**
 * Row count of a query built with select(..., { count: 'exact', head: true }).
 * supabase-js turns a HEAD 404 (e.g. a missing table) into an empty success,
 * so a missing count is treated as an error rather than as zero.
 */
async function countOf(promise) {
  const { error, count } = await promise;
  if (error) throw Object.assign(new Error(`db: ${error.message || error.code || 'error'}`), { code: error.code });
  if (typeof count !== 'number') throw Object.assign(new Error('db: count unavailable (is supabase/schema.sql applied?)'), { code: 'NO_COUNT' });
  return count;
}

// One table per schema step, so a migration that was not run shows up in /api/health.
const HEALTH_TABLES = { categories: 'id', call_queue: 'id', google_reviews: 'id', app_settings: 'key', cases: 'id', case_events: 'id' };

/** Cheap reads used by the health check; null when all answer, else "<table>:<error code>". */
async function dbProblem(db) {
  for (const [table, col] of Object.entries(HEALTH_TABLES)) {
    try {
      const { error } = await db.from(table).select(col).limit(1);
      if (error) return `${table}:${error.code || 'error'}`;
    } catch (e) {
      return `${table}:${e.code || 'unreachable'}`;
    }
  }
  return null;
}

const PAGE = 1000;

/**
 * Fetch every row of a query, paging past PostgREST's max-rows limit.
 * `build` must return a fresh, ordered query each call.
 */
async function fetchAll(build, cap = 100000) {
  const out = [];
  for (let from = 0; from < cap; from += PAGE) {
    const rows = await must(build().range(from, from + PAGE - 1));
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function audit(db, username, action, details) {
  try {
    await must(db.from('audit_log').insert({ username: username || null, action, details: details ? String(details).slice(0, 300) : null }));
  } catch (e) {
    console.error('audit failed', e.message);
  }
}

module.exports = { createSupabase, normalizeSupabaseUrl, must, countOf, dbProblem, fetchAll, audit };
