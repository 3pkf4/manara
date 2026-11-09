/* ============================================================
   الباركود (واجهة المتصفح): تحقق، ترميز EAN-13 إلى SVG للملصقات، فك باركود الميزان،
   البحث في المنتجات المحلية (رئيسي/إضافي/ميزان)، ومسح بكاميرا الهاتف.
   المسح بالكاميرا: BarcodeDetector إن توفر، وإلا فك EAN/UPC مدمج (بدون مكتبات خارجية).
   الماسح الليزري/البلوتوث يعمل كلوحة مفاتيح ويُعالَج في Barcode.attachScannerListener.
   ============================================================ */
(function () {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const R = L.map(b => b.replace(/[01]/g, c => (c === '0' ? '1' : '0')));
  const G = R.map(b => b.split('').reverse().join(''));
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  // عروض العناصر (للفك): L بالأعمدة، G معكوسها
  const LW = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'].map(s => s.split('').map(Number));
  const GW = LW.map(a => a.slice().reverse());

  function ean13Check(d12) { let s = 0; for (let i = 0; i < 12; i++) s += (+d12[i]) * (i % 2 === 0 ? 1 : 3); return (10 - (s % 10)) % 10; }
  function ean8Check(d7) { let s = 0; for (let i = 0; i < 7; i++) s += (+d7[i]) * (i % 2 === 0 ? 3 : 1); return (10 - (s % 10)) % 10; }
  const isEAN13 = (c) => /^\d{13}$/.test(c) && ean13Check(c.slice(0, 12)) === +c[12];
  const isEAN8 = (c) => /^\d{8}$/.test(c) && ean8Check(c.slice(0, 7)) === +c[7];
  const isUPCA = (c) => /^\d{12}$/.test(c) && isEAN13('0' + c);
  /** يعيد EAN-13 من 12 رقماً (UPC-A) أو 13؛ وإلا null */
  function toEAN13(c) { if (isEAN13(c)) return c; if (isUPCA(c)) return '0' + c; return null; }

  /** باركود ميزان: 2 + PLU(6) + غرامات(5) + تحقق. لا يبدأ بـ29 (داخلي). */
  function decodeScale(code) {
    if (!isEAN13(code) || code[0] !== '2' || code[1] === '9') return null;
    return { plu: String(parseInt(code.slice(1, 7), 10)), grams: parseInt(code.slice(7, 12), 10) };
  }

  /** البحث في قائمة منتجات محلية. يعيد {product, qty, kind} أو null */
  function find(products, raw) {
    const code = String(raw || '').trim();
    if (!code) return null;
    const lc = code.toLowerCase();
    for (const p of products) if (p.barcode && p.barcode.toLowerCase() === lc) return { product: p, qty: 1, kind: 'main' };
    for (const p of products) {
      const x = (p.extra_barcodes || []).find(b => b.barcode.toLowerCase() === lc);
      if (x) return { product: p, qty: parseFloat(x.pack_qty) || 1, kind: 'pack' };
    }
    const sc = decodeScale(code);
    if (sc) {
      const p = products.find(p => p.sold_by_weight && p.plu && String(parseInt(p.plu, 10)) === sc.plu);
      if (p) return { product: p, qty: sc.grams / 1000, kind: 'scale' };
    }
    // UPC-A ↔ EAN-13 (صفر بادئ)
    if (/^\d{12}$/.test(code)) return find(products, '0' + code);
    if (/^0\d{12}$/.test(code)) { const h = find(products, code.slice(1)); if (h) return h; }
    return null;
  }

  /** ترميز EAN-13 إلى SVG (نص). يعيد null إن لم يكن الرمز EAN-13/UPC-A صالحاً. */
  function svgEAN13(raw, opts = {}) {
    const code = toEAN13(String(raw));
    if (!code) return null;
    const mod = opts.module || 2, h = opts.height || 60, quiet = 9 * mod, fs = opts.fontSize || 11;
    const par = PARITY[+code[0]];
    let bits = '101';
    for (let i = 0; i < 6; i++) bits += (par[i] === 'L' ? L : G)[+code[1 + i]];
    bits += '01010';
    for (let i = 0; i < 6; i++) bits += R[+code[7 + i]];
    bits += '101';
    const w = bits.length * mod + quiet * 2, th = h + fs + 6;
    let rects = '';
    const guard = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;
    for (let i = 0; i < bits.length; ) {
      if (bits[i] !== '1') { i++; continue; }
      let j = i; while (j < bits.length && bits[j] === '1') j++;
      const bh = guard(i) ? h + 5 : h;
      rects += `<rect x="${quiet + i * mod}" y="0" width="${(j - i) * mod}" height="${bh}"/>`;
      i = j;
    }
    const t = (x, s, anchor) => `<text x="${x}" y="${th - 1}" font-size="${fs}" text-anchor="${anchor}" font-family="monospace" letter-spacing="1.5">${s}</text>`;
    const text = t(quiet - 3, code[0], 'end') + t(quiet + 3 * mod + 21 * mod, code.slice(1, 7), 'middle') + t(quiet + 50 * mod + 21 * mod, code.slice(7), 'middle');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${th}" width="${w}" height="${th}" fill="#000"><rect width="${w}" height="${th}" fill="#fff"/>${rects}${text}</svg>`;
  }


  // ---------- Code 128 (مجموعة B: ASCII 32..126) للباركودات النصية/القصيرة ----------
  const C128 = "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112".split(' ');
  function code128Codes(text) {
    const vals = [104];
    for (const ch of String(text)) vals.push(ch.charCodeAt(0) - 32);
    let sum = 104; for (let i = 1; i < vals.length; i++) sum += i * vals[i];
    vals.push(sum % 103, 106);
    return vals;
  }
  function isCode128Text(t) { return /^[\x20-\x7e]{1,40}$/.test(String(t)); }
  function svgCode128(text, opts = {}) {
    if (!isCode128Text(text)) return null;
    const mod = opts.module || 2, h = opts.height || 60, fs = opts.fontSize || 11, quiet = 10 * mod;
    let x = quiet, rects = '';
    for (const v of code128Codes(text)) {
      const w = C128[v];
      for (let i = 0; i < w.length; i++) {
        const wd = +w[i] * mod;
        if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${wd}" height="${h}"/>`;
        x += wd;
      }
    }
    const total = x + quiet, th = h + fs + 6;
    const esc = String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${th}" width="${total}" height="${th}" fill="#000"><rect width="${total}" height="${th}" fill="#fff"/>${rects}<text x="${total / 2}" y="${th - 1}" font-size="${fs}" text-anchor="middle" font-family="monospace">${esc}</text></svg>`;
  }
  /** يرسم الباركود المناسب: EAN-13/UPC-A إن كان صالحاً، وإلا Code 128. */
  function svgBarcode(code, opts) { return svgEAN13(code, opts) || svgCode128(code, opts); }

  // ---------- فك EAN-13 / EAN-8 من صف بكسلات ----------
  function runsFromRow(lum) {
    const n = lum.length, win = Math.max(15, (n / 10) | 0);
    // عتبة محلية (متوسط متحرك) تتحمّل الإضاءة غير المتجانسة
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + lum[i];
    const runs = []; let cur = null, len = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - win), b = Math.min(n, i + win);
      const mean = (pre[b] - pre[a]) / (b - a);
      const bar = lum[i] < mean * 0.94;
      if (cur === null) { cur = bar; len = 1; }
      else if (bar === cur) len++;
      else { runs.push([cur, len]); cur = bar; len = 1; }
    }
    runs.push([cur, len]);
    return runs; // [isBar, length]
  }
  function matchDigit(w4, tables) {
    const t = w4[0] + w4[1] + w4[2] + w4[3]; if (t < 4) return null;
    const norm = w4.map(x => x * 7 / t);
    let best = null, bestErr = 1e9;
    for (const [name, tab] of tables) for (let d = 0; d < 10; d++) {
      let e = 0; for (let k = 0; k < 4; k++) e += Math.abs(norm[k] - tab[d][k]);
      if (e < bestErr) { bestErr = e; best = { d, name }; }
    }
    return bestErr < 1.6 ? best : null;
  }
  function tryDecode(runs) {
    for (let s = 1; s + 3 < runs.length; s++) {
      if (!runs[s][0]) continue; // الحارس يبدأ بشريط
      const g = [runs[s][1], runs[s + 1][1], runs[s + 2][1]], m = (g[0] + g[1] + g[2]) / 3;
      if (m < 1 || g.some(x => Math.abs(x - m) > m * 0.6)) continue;
      if (runs[s - 1][1] < m * 4 && s - 1 !== 0) continue; // منطقة هادئة قبل البداية
      for (const kind of [13, 8]) {
        const half = kind === 13 ? 6 : 4;
        let p = s + 3, digits = [], names = '', ok = true;
        for (let k = 0; k < half && ok; k++) {
          if (p + 3 >= runs.length) { ok = false; break; }
          const r = matchDigit([runs[p][1], runs[p + 1][1], runs[p + 2][1], runs[p + 3][1]], [['L', LW], ['G', GW]]);
          if (!r) ok = false; else { digits.push(r.d); names += r.name; p += 4; }
        }
        if (!ok || p + 4 >= runs.length) continue;
        const c = runs.slice(p, p + 5).map(x => x[1]); const cm = (c[0] + c[1] + c[2] + c[3] + c[4]) / 5;
        if (c.some(x => Math.abs(x - cm) > cm * 0.7)) continue;
        p += 5;
        const right = [];
        for (let k = 0; k < half && ok; k++) {
          if (p + 3 >= runs.length) { ok = false; break; }
          const r = matchDigit([runs[p][1], runs[p + 1][1], runs[p + 2][1], runs[p + 3][1]], [['L', LW]]);
          if (!r) ok = false; else { right.push(r.d); p += 4; }
        }
        if (!ok) continue;
        if (kind === 13) {
          const first = PARITY.indexOf(names); if (first < 0) continue;
          const code = String(first) + digits.join('') + right.join('');
          if (isEAN13(code)) return code;
        } else {
          if (names !== 'LLLL') continue;
          const code = digits.join('') + right.join('');
          if (isEAN8(code)) return code;
        }
      }
    }
    return null;
  }
  /** يفك صفاً واحداً من البكسلات (Uint8/array من الإضاءة 0..255). يجرّب الاتجاهين. */
  function decodeRow(lum) {
    const runs = runsFromRow(lum);
    return tryDecode(runs) || tryDecode(runs.slice().reverse());
  }
  /** يفك صورة (ImageData): يجرّب عدة صفوف حول المنتصف. */
  function decodeImageData(img) {
    const { width: w, height: h, data } = img;
    const lum = new Float64Array(w);
    const rows = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.5];
    for (const f of rows) {
      const y = Math.min(h - 1, Math.max(0, Math.round(h * f)));
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; lum[x] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; }
      const r = decodeRow(lum); if (r) return r;
    }
    return null;
  }

  // ---------- ماسح الكاميرا ----------
  let scanner = null;
  function beep() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination); o.frequency.value = 1100; g.gain.value = 0.15; o.start(); o.stop(a.currentTime + 0.12);
      setTimeout(() => a.close(), 300);
    } catch (e) {}
    try { navigator.vibrate && navigator.vibrate(60); } catch (e) {}
  }
  /**
   * يفتح نافذة الكاميرا. opts: {continuous:boolean, title, onCode(code) => void|false}
   * في الوضع المستمر تبقى النافذة مفتوحة (مع منع تكرار نفس الرمز خلال 1.5 ثانية).
   */
  async function openScanner(opts = {}) {
    if (scanner) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('الكاميرا غير متاحة. تحتاج الصفحة إلى اتصال آمن (https) ومتصفحاً حديثاً.'); return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:#000d;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;direction:rtl;font-family:inherit';
    wrap.innerHTML = `<div style="color:#fff;font-weight:700">${opts.title || 'وجّه الكاميرا نحو الباركود'}</div>
      <div style="position:relative;width:min(92vw,520px);aspect-ratio:4/3;background:#000;border-radius:14px;overflow:hidden">
        <video playsinline muted style="width:100%;height:100%;object-fit:cover"></video>
        <div style="position:absolute;inset:30% 8%;border:2px solid #f2a900;border-radius:10px;box-shadow:0 0 0 999px #0006"></div>
        <div style="position:absolute;left:8%;right:8%;top:50%;height:2px;background:#ff3b30aa"></div>
      </div>
      <div id="bc-msg" style="color:#ffd36b;font-size:13px;min-height:20px;text-align:center"></div>
      <div style="display:flex;gap:10px"><button id="bc-torch" style="display:none;padding:10px 16px;border-radius:10px;border:0;background:#fff2;color:#fff"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-bulb"/></svg> الفلاش</button>
      <button id="bc-manual" style="padding:10px 16px;border-radius:10px;border:0;background:#fff2;color:#fff">إدخال يدوي</button>
      <button id="bc-close" style="padding:10px 22px;border-radius:10px;border:0;background:#f2a900;color:#1a1300;font-weight:700">إغلاق</button></div>`;
    document.body.appendChild(wrap);
    const video = wrap.querySelector('video'), msg = wrap.querySelector('#bc-msg');
    let stream = null, stopped = false, last = '', lastAt = 0, timer = null;
    const stop = () => {
      stopped = true; clearTimeout(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      wrap.remove(); scanner = null;
    };
    scanner = { stop };
    wrap.querySelector('#bc-close').onclick = stop;
    wrap.querySelector('#bc-manual').onclick = () => {
      const v = prompt('اكتب أو الصق رقم الباركود'); if (v && v.trim()) { handle(v.trim()); }
    };
    const handle = (code) => {
      const now = Date.now();
      if (code === last && now - lastAt < 1500) return;
      last = code; lastAt = now; beep();
      const keep = opts.onCode && opts.onCode(code);
      if (!opts.continuous || keep === false) stop();
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      msg.textContent = (e && e.name === 'NotAllowedError') ? 'لم يُسمح باستخدام الكاميرا. فعّل الإذن من إعدادات المتصفح/التطبيق.' : 'تعذر فتح الكاميرا.';
      return;
    }
    video.srcObject = stream; await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    try { if (track.getCapabilities && track.getCapabilities().torch) { const tb = wrap.querySelector('#bc-torch'); tb.style.display = ''; let on = false; tb.onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); }; } } catch (e) {}

    let detector = null;
    if ('BarcodeDetector' in window) {
      try { detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'] }); } catch (e) { detector = null; }
    }
    msg.textContent = detector ? '' : 'وضع المسح المدمج (EAN/UPC). قرّب الباركود وثبّته.';
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    const loop = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) {
          if (detector) {
            const found = await detector.detect(video);
            if (found.length) handle(found[0].rawValue);
          } else {
            const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth) || 480;
            canvas.width = w; canvas.height = h; ctx.drawImage(video, 0, 0, w, h);
            const c = decodeImageData(ctx.getImageData(0, 0, w, h)); if (c) handle(c);
          }
        }
      } catch (e) {}
      timer = setTimeout(loop, detector ? 120 : 90);
    };
    loop();
  }

  /**
   * يلتقط إدخال الماسح الليزري/البلوتوث (يعمل كلوحة مفاتيح: أرقام سريعة ثم Enter)
   * حتى لو لم يكن أي حقل في وضع التركيز. يتجاهل الكتابة البشرية البطيئة.
   * isActive(): هل نقبل الإدخال الآن (مثلاً شاشة البيع ظاهرة)؟
   */
  function attachScannerListener(onScan, isActive) {
    let buf = '', lastT = 0, timer = null;
    document.addEventListener('keydown', (e) => {
      if (isActive && !isActive()) return;
      const el = document.activeElement, tag = el && el.tagName;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // إن كان التركيز في حقل نصي آخر غير البحث لا نتدخل
      if (el && (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !el.dataset.scanTarget))) return;
      const now = Date.now();
      if (e.key === 'Enter') {
        if (buf.length >= 4) { const code = buf; buf = ''; if (!(el && el.dataset && el.dataset.scanTarget)) { e.preventDefault(); onScan(code); } }
        buf = ''; return;
      }
      if (e.key.length !== 1) return;
      if (now - lastT > 60) buf = ''; // فاصل كبير = كتابة بشرية، نبدأ من جديد
      buf += e.key; lastT = now;
      clearTimeout(timer); timer = setTimeout(() => { buf = ''; }, 300);
    }, true);
  }

  window.Barcode = { svgCode128, svgBarcode, code128Codes, beep, ean13Check, isEAN13, isEAN8, isUPCA, toEAN13, decodeScale, find, svgEAN13, decodeRow, decodeImageData, openScanner, attachScannerListener };
})();
