'use strict';

// One-off: creates the first "admin" account and prints its temporary password once.
// Usage (Render Shell or locally with .env): node server/seed-admin.js

require('dotenv').config({ quiet: true });
const { createSupabase, must, audit } = require('./db');
const { hashPassword, randomPassword } = require('./auth');

async function seedAdmin(db) {
  const existing = await must(db.from('app_users').select('id').eq('username', 'admin').maybeSingle());
  if (existing) return { created: false };
  const password = randomPassword(10);
  await must(db.from('app_users').insert({
    username: 'admin', name: 'مدير النظام', role: 'admin', branch: null,
    password_hash: await hashPassword(password), active: true, must_change: true
  }));
  await audit(db, 'system', 'seed_admin', 'admin');
  return { created: true, password };
}

if (require.main === module) {
  const db = createSupabase(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  seedAdmin(db).then(r => {
    if (!r.created) {
      console.log('حساب admin موجود مسبقاً — لم يتم إنشاء شيء.');
      return;
    }
    console.log('تم إنشاء حساب الإدارة.');
    console.log('  اسم المستخدم: admin');
    console.log(`  كلمة المرور المؤقتة: ${r.password}`);
    console.log('احفظها الآن — لن تظهر مرة أخرى، وسيُطلب تغييرها عند أول دخول.');
  }).catch(e => {
    console.error('فشل الإنشاء:', e.message);
    process.exit(1);
  });
}

module.exports = { seedAdmin };
