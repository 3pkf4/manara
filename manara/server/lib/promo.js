/**
 * أفضل عرض فعّال للمنتج (الأقل سعراً) — جزء SQL يُستعمل مع جدول products بالاسم p.
 * ينتج الأعمدة: promo.price, promo.name, promo.id
 */
const PROMO_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT x.price, x.name, x.id FROM (
      SELECT pr.id, pr.name,
             CASE pr.kind WHEN 'percent' THEN ROUND(p.sell_price * (1 - pr.value / 100), 2) ELSE pr.value END AS price
        FROM promotions pr
       WHERE pr.tenant_id = p.tenant_id AND pr.is_active
         AND pr.starts_at <= NOW() AND (pr.ends_at IS NULL OR pr.ends_at > NOW())
         AND (pr.branch_id IS NULL OR pr.branch_id = p.branch_id)
         AND (pr.product_id = p.id OR (pr.product_id IS NULL AND pr.category = p.category))
    ) x WHERE x.price < p.sell_price ORDER BY x.price ASC LIMIT 1
  ) promo ON TRUE`;
module.exports = { PROMO_LATERAL };
