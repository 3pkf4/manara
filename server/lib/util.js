/** أدوات مشتركة: أرقام آمنة، عدّادات مستندات، إعدادات المتجر */

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

/** يحوّل قيمة إلى رقم منتهٍ، أو يرمي HttpError 400. */
function num(v, { name = 'القيمة', min = -Infinity, max = Infinity, def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  // نرفض النصوص غير الرقمية صراحةً (parseFloat("12abc") تعيد 12)
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} غير صالحة`);
  if (n < min || n > max) throw new HttpError(400, `${name} خارج النطاق المسموح`);
  return n;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** رقم تسلسلي ذرّي لكل (متجر، نوع، سنة). آمن مع الطلبات المتزامنة. */
async function nextNumber(client, tenantId, docType, prefix) {
  const year = new Date().getFullYear();
  const r = await client.query(
    `INSERT INTO doc_counters (tenant_id, doc_type, year, last_value)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, doc_type, year)
     DO UPDATE SET last_value = doc_counters.last_value + 1
     RETURNING last_value`,
    [tenantId, docType, year]
  );
  return `${prefix}-${year}-${String(r.rows[0].last_value).padStart(5, '0')}`;
}

/** قراءة إعدادات المتجر كـ Object */
async function getSettings(client, tenantId) {
  const r = await client.query(
    'SELECT setting_key, setting_value FROM tenant_settings WHERE tenant_id = $1',
    [tenantId]
  );
  const s = {};
  for (const row of r.rows) s[row.setting_key] = row.setting_value;
  return s;
}

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

/** تعقيم قيمة CSV (منع حقن الصيغ في Excel) وتغليفها */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** يبني ملف CSV (مع BOM كي يقرأ Excel العربية بشكل صحيح) */
function toCsv(columns, rows) {
  const head = columns.map(c => csvCell(c.label)).join(',');
  const body = rows.map(r => columns.map(c => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

/** يطبّع رقم هاتف ليبي لصيغة دولية لاستخدامه مع wa.me */
function normalizePhoneLY(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('218')) return d.length >= 11 ? d : null;
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 9 ? '218' + d : null;
}

module.exports = { HttpError, num, round2, round3, nextNumber, getSettings, truthy, csvCell, toCsv, normalizePhoneLY };
