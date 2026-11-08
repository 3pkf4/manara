/* ============================================================
   العمل بدون إنترنت: لقطة محلية للمنتجات والعملاء + طابور مبيعات.
   - المبيعات تُحفظ في IndexedDB بمعرّف local_id فريد ثم تُرسل عند عودة الاتصال.
   - الخادم يتجاهل التكرار بنفس local_id، فلا تتكرر فاتورة إن أُعيد الإرسال.
   - لا يُسمح بالبيع الآجل بدون اتصال (لا يمكن التحقق من سقف الدين).
   ============================================================ */
(function () {
  const DB_NAME = 'manara-offline', DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB غير مدعوم'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'local_id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; }).catch(reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  const Offline = {
    listeners: [],
    uid() {
      const c = window.crypto;
      return (c && c.randomUUID) ? c.randomUUID() : 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    },
    isOffline() { return navigator.onLine === false; },

    // ---- لقطة البيانات (مفتاحها لكل مستخدم/متجر كي لا تختلط) ----
    scope() { try { const u = (window.APP && APP.user) || JSON.parse(localStorage.getItem('manara_user') || '{}'); return (u.tenant_id || u.tenantId || 'x') + ':' + (u.branch_id || u.branchId || 'x'); } catch { return 'x'; } },
    async saveSnapshot(name, data) {
      try { await tx('kv', 'readwrite', s => wrap(s.put({ at: Date.now(), data }, this.scope() + ':' + name))); } catch (e) { /* التخزين غير متاح */ }
    },
    async loadSnapshot(name) {
      try { const v = await tx('kv', 'readonly', s => wrap(s.get(this.scope() + ':' + name))); return v || null; } catch { return null; }
    },

    // ---- الطابور ----
    async enqueue(entry) {
      await tx('queue', 'readwrite', s => wrap(s.put(entry)));
      this.emit();
    },
    async list() {
      try { return (await tx('queue', 'readonly', s => wrap(s.getAll()))).sort((a, b) => a.created_at - b.created_at); } catch { return []; }
    },
    async remove(localId) { await tx('queue', 'readwrite', s => wrap(s.delete(localId))); this.emit(); },
    async count() { return (await this.list()).length; },

    on(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach(f => { try { f(); } catch (e) {} }); },

    /** يرسل الطابور بالترتيب. يتوقف عند انقطاع الاتصال أو انتهاء الجلسة. */
    flushing: false,
    async flush(send) {
      if (this.flushing || this.isOffline()) return { sent: 0, failed: 0 };
      this.flushing = true;
      let sent = 0, failed = 0;
      try {
        for (const item of await this.list()) {
          if (item.error && item.error_permanent) { failed++; continue; }
          const res = await send(item);
          if (res.network) break;                       // لا اتصال: نحاول لاحقاً
          if (res.auth) break;                          // تحتاج تسجيل دخول
          if (res.ok) { await this.remove(item.local_id); sent++; }
          else {                                        // رفض من الخادم (مخزون/وردية/…): لا نعيد المحاولة تلقائياً
            item.error = res.error || 'رُفضت من الخادم'; item.error_permanent = true;
            await this.enqueue(item); failed++;
          }
        }
      } finally { this.flushing = false; this.emit(); }
      return { sent, failed };
    }
  };
  window.Offline = Offline;
})();
