/* ============================================================
   Service Worker — يخزّن الملفات للعمل بدون إنترنت
   ============================================================ */

const CACHE_NAME = 'manara-pos-v2.9.1';
const RUNTIME_CACHE = 'manara-runtime-v2.9.1';

// الملفات التي تُخزّن دائماً
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/tools.html',
  '/data.html',
  '/inventory.html',
  '/js/barcode.js',
  '/css/brand.css',
  '/css/ui.css',
  '/js/icons.js',
  '/js/offline.js',
  '/js/save-file.js',
  '/icons/logo.svg',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ============================================================
// تثبيت — تخزين الملفات الأساسية
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pre-caching app shell');
        return cache.addAll(PRECACHE_URLS).catch(err => {
          console.warn('[SW] Some files failed to cache:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ============================================================
// تنشيط — حذف الكاش القديم
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME && name !== RUNTIME_CACHE)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================
// Fetch — استراتيجية ذكية
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // تجاهل الطلبات غير GET
  if (request.method !== 'GET') return;

  // تجاهل طلبات API — دائماً من الشبكة
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ ok: false, error: 'لا يوجد اتصال بالإنترنت' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // لا تخزّن من نطاقات أخرى (مثل Chart.js CDN)
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        return cached || fetch(request).catch(() => cached);
      })
    );
    return;
  }
  // HTML — دائماً من الشبكة (لتجنب مشاكل الكاش)
  if (url.pathname === '/' || url.pathname === '/index.html' || 
      url.pathname === '/admin.html' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(request).then(response => {
        // حدّث الكاش في الخلفية
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }
  // استراتيجية: Cache First مع تحديث في الخلفية
  event.respondWith(
    caches.match(request).then(cached => {
      const fetchPromise = fetch(request).then(response => {
        // حدّث الكاش إذا كانت الاستجابة ناجحة
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => {
            cache.put(request, responseClone);
          });
        }
        return response;
      }).catch(() => cached);

      // أعد المخزّن أولاً (سريع)، وحدّث في الخلفية
      return cached || fetchPromise;
    })
  );
});

// ============================================================
// رسائل من التطبيق
// ============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(names => {
      names.forEach(name => caches.delete(name));
    });
  }
});

// ============================================================
// إشعارات Push (للمستقبل)
// ============================================================
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'المنارة POS';
  const options = {
    body: data.body || 'لديك إشعار جديد',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    dir: 'rtl',
    lang: 'ar'
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
