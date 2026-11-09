/**
 * نظام الأكواد: أكواد عشوائية قوية لمرة واحدة، تُخزَّن مجزّأة (SHA-256).
 * لا يمكن تخمين الكود ولا استنتاجه من بادئته، ولا يُستخدم مرتين.
 */
const crypto = require('crypto');
const { HttpError } = require('./util');

const MIN = 1, HOUR = 60, DAY = 24 * 60;
const PLANS = {
  DEMO2H: { name: 'باقة تجريبية (ساعتان)', minutes: 2 * HOUR },
  WEEK:   { name: 'باقة أسبوعية',  minutes: 7 * DAY },
  MONTH:  { name: 'باقة شهرية',    minutes: 30 * DAY },
  YEAR:   { name: 'باقة سنوية',    minutes: 365 * DAY },
  LIFE:   { name: 'باقة دائمة (10 سنوات)', minutes: 3650 * DAY }
};

// أبجدية بلا حروف ملتبسة (0/O و1/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomGroup(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/** ينشئ كوداً بصيغة MNR-PLAN-XXXX-XXXX-XXXX-XXXX (80 بت عشوائية) */
function generateCode(plan) {
  if (!PLANS[plan]) throw new HttpError(400, 'خطة غير معروفة. المتاح: ' + Object.keys(PLANS).join(', '));
  return `MNR-${plan}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

/** يُنشئ n كوداً ويحفظ هاشاتها. يعيد الأكواد الأصلية (تُعرض مرة واحدة فقط). */
async function createCodes(client, { plan, count = 1, tenantId = null, createdBy = null, note = null, withIds = false }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode(plan);
    await client.query(
      `INSERT INTO license_codes (code_hash, code_hint, plan, duration_minutes, tenant_id, created_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [hashCode(code), code.slice(-4), plan, PLANS[plan].minutes, tenantId, createdBy, note]
    ).then(r => { if (withIds) out.push({ id: r.rows[0].id, code }); });
    if (!withIds) out.push(code);
  }
  return out;
}

/**
 * يستهلك الكود ذرّياً ويمدّد اشتراك المتجر.
 * UPDATE ... WHERE used_at IS NULL يضمن أن كوداً واحداً لا يُستخدم مرتين حتى مع التزامن.
 */
async function redeemCode(client, { code, tenantId }) {
  const norm = normalizeCode(code);
  if (norm.length < 16) throw new HttpError(400, 'كود غير صالح');

  const used = await client.query(
    `UPDATE license_codes
        SET used_at = NOW(), used_by_tenant = $1
      WHERE code_hash = $2 AND used_at IS NULL AND revoked_at IS NULL
        AND (tenant_id IS NULL OR tenant_id = $1)
      RETURNING plan, duration_minutes`,
    [tenantId, hashCode(code)]
  );
  if (!used.rows.length) throw new HttpError(400, 'كود غير صالح أو مستخدم مسبقاً');

  const { plan, duration_minutes } = used.rows[0];
  const end = await extendSubscription(client, tenantId, duration_minutes);
  return { plan, plan_name: PLANS[plan].name, subscription_end: end };
}

/** يمدّد اشتراك المتجر من تاريخ انتهائه الحالي (أو من الآن إن كان منتهياً). */
async function extendSubscription(client, tenantId, minutes) {
  const upd = await client.query(
    `UPDATE tenants
        SET subscription_status = 'active',
            is_trial = FALSE,
            subscription_end = GREATEST(COALESCE(subscription_end, NOW()), NOW())
                               + ($2::bigint * INTERVAL '1 minute'),
            updated_at = NOW()
      WHERE id = $1
      RETURNING subscription_end, business_name`,
    [tenantId, minutes]
  );
  if (!upd.rows.length) throw new HttpError(404, 'المتجر غير موجود');
  return upd.rows[0].subscription_end;
}

module.exports = { PLANS, generateCode, createCodes, redeemCode, extendSubscription, hashCode, normalizeCode };
