'use strict';

const { createClient } = require('@supabase/supabase-js');

/** Server-only Supabase client (service role bypasses RLS). Never expose this key to the browser. */
function createSupabase(url, serviceKey) {
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
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

/** Cheap read used by the health check; returns null when the database answers, else an error code. */
async function dbProblem(db) {
  try {
    const { error } = await db.from('categories').select('id').limit(1);
    return error ? error.code || 'error' : null;
  } catch (e) {
    return e.code || 'unreachable';
  }
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

module.exports = { createSupabase, must, countOf, dbProblem, fetchAll, audit };
