const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { authenticate, requireRole, checkTenantActive } = require('../middleware/auth');

// الرابط العام الحالي للنفق — لمديري المتاجر فقط (لم يعد متاحاً للعموم)
router.get('/', authenticate, checkTenantActive, requireRole('owner', 'tenant_admin'), (req, res) => {
  try {
    const urlFile = path.join(__dirname, '../../data/public-url.txt');
    if (!fs.existsSync(urlFile)) {
      return res.json({ ok: true, url: null, status: 'no_tunnel', message: 'لم يتم تشغيل النفق بعد' });
    }
    const url = fs.readFileSync(urlFile, 'utf8').trim();
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) return res.json({ ok: true, url: null, status: 'invalid' });
    res.json({ ok: true, url, status: 'active', remote_url: url + '/remote' });
  } catch (e) {
    res.json({ ok: false, error: 'تعذر قراءة الرابط' });
  }
});

module.exports = router;
