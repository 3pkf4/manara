#!/bin/bash
_D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; set -a; [ -f "$_D/.env" ] && . "$_D/.env"; set +a
# ============================================================
# المنارة POS - سكريبت الإدارة
# ============================================================

PROJECT_DIR="/home/mohammed/manara-saas"
PM2_NAME="manara-pos"
PORT=3000

# ألوان
G='\033[0;32m'
R='\033[0;31m'
Y='\033[1;33m'
B='\033[0;34m'
C='\033[0;36m'
N='\033[0m'
BOLD='\033[1m'

# ============================================================
# دالة: طباعة العنوان
# ============================================================
header() {
  clear
  echo -e "${B}╔══════════════════════════════════════════════╗${N}"
  echo -e "${B}║${N}  ${BOLD}🏪 المنارة POS & ERP${N}                      ${B}║${N}"
  echo -e "${B}║${N}  نظام نقاط البيع والمخزون                   ${B}║${N}"
  echo -e "${B}╚══════════════════════════════════════════════╝${N}"
  echo ""
}

# ============================================================
# دالة: عرض القائمة
# ============================================================
show_menu() {
  header
  echo -e "${BOLD}الحالة الحالية:${N}"
  STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for app in data:
        if app['name'] == '$PM2_NAME':
            s = app['pm2_env']['status']
            m = round(app['monit']['memory'] / 1024 / 1024, 1)
            u = app['pm2_env'].get('pm_uptime', 0)
            print(f'{s}|{m}|{u}')
            break
    else:
        print('not_found|0|0')
except: print('error|0|0')
")
  
  IFS='|' read -r status mem uptime <<< "$STATUS"
  
  if [ "$status" = "online" ]; then
    echo -e "  الخادم: ${G}● يعمل${N} (${mem}MB)"
    echo -e "  الرابط: ${C}http://localhost:$PORT${N}"
  elif [ "$status" = "stopped" ]; then
    echo -e "  الخادم: ${R}● متوقف${N}"
  elif [ "$status" = "errored" ]; then
    echo -e "  الخادم: ${R}● خطأ${N}"
  else
    echo -e "  الخادم: ${Y}● غير مُشغّل${N}"
  fi
  
  echo ""
  echo -e "${BOLD}الخيارات:${N}"
  echo -e "  ${G}1${N}) تشغيل الخادم"
  echo -e "  ${Y}2${N}) إيقاف الخادم"
  echo -e "  ${C}3${N}) إعادة تشغيل"
  echo -e "  ${B}4${N}) عرض السجلات (Logs)"
  echo -e "  ${B}5${N}) حالة PM2 التفصيلية"
  echo -e "  ${B}6${N}) نسخة احتياطية الآن"
  echo -e "  ${B}7${N}) عرض النسخ الاحتياطية"
  echo -e "  ${B}8${N}) فتح التطبيق في المتصفح"
  echo -e "  ${B}9${N}) فتح لوحة المالك"
  echo -e "  ${B}10${N}) اختبار النظام"
  echo -e "  ${B}11${N}) معلومات النظام"
  echo -e "  ${R}0${N}) خروج"
  echo ""
}

# ============================================================
# دالة: انتظر مفتاح
# ============================================================
pause() {
  echo ""
  echo -e "${Y}اضغط Enter للمتابعة...${N}"
  read
}

# ============================================================
# دالة: تشغيل
# ============================================================
start_server() {
  header
  echo -e "${C}▶ بدء تشغيل الخادم...${N}"
  cd "$PROJECT_DIR" || exit 1
  pm2 start ecosystem.config.js 2>/dev/null || pm2 start server/server.js --name "$PM2_NAME"
  pm2 save
  sleep 2
  if pm2 jlist | grep -q '"name":"'$PM2_NAME'"' && pm2 jlist | grep -q '"status":"online"'; then
    echo -e "${G}✅ الخادم يعمل الآن${N}"
    echo -e "🌐 http://localhost:$PORT"
  else
    echo -e "${R}❌ فشل التشغيل — تحقق من السجلات${N}"
  fi
  pause
}

# ============================================================
# دالة: إيقاف
# ============================================================
stop_server() {
  header
  echo -e "${Y}■ إيقاف الخادم...${N}"
  pm2 stop "$PM2_NAME"
  pm2 save
  echo -e "${G}✅ تم الإيقاف${N}"
  pause
}

# ============================================================
# دالة: إعادة تشغيل
# ============================================================
restart_server() {
  header
  echo -e "${C}🔄 إعادة تشغيل الخادم...${N}"
  pm2 restart "$PM2_NAME"
  sleep 2
  echo -e "${G}✅ تم إعادة التشغيل${N}"
  pause
}

# ============================================================
# دالة: السجلات
# ============================================================
show_logs() {
  header
  echo -e "${B}📋 السجلات الأخيرة (Ctrl+C للخروج)${N}"
  echo -e "${Y}----------------------------------------${N}"
  pm2 logs "$PM2_NAME" --lines 50
}

# ============================================================
# دالة: حالة PM2
# ============================================================
pm2_status() {
  header
  pm2 status
  echo ""
  echo -e "${B}معلومات إضافية:${N}"
  pm2 show "$PM2_NAME" 2>/dev/null | head -25
  pause
}

# ============================================================
# دالة: نسخة احتياطية
# ============================================================
run_backup() {
  header
  echo -e "${C}💾 إنشاء نسخة احتياطية...${N}"
  echo ""
  "$PROJECT_DIR/server/scripts/backup.sh"
  pause
}

# ============================================================
# دالة: عرض النسخ الاحتياطية
# ============================================================
list_backups() {
  header
  echo -e "${B}📁 النسخ الاحتياطية:${N}"
  echo ""
  if [ -d "$PROJECT_DIR/backups/db" ]; then
    echo -e "${BOLD}قاعدة البيانات:${N}"
    ls -lh "$PROJECT_DIR/backups/db/" 2>/dev/null | tail -n +2 | awk '{print "  " $9 " (" $5 ")"}'
  fi
  echo ""
  if [ -d "$PROJECT_DIR/backups/files" ]; then
    echo -e "${BOLD}الإعدادات:${N}"
    ls -lh "$PROJECT_DIR/backups/files/" 2>/dev/null | tail -n +2 | awk '{print "  " $9 " (" $5 ")"}'
  fi
  echo ""
  TOTAL=$(du -sh "$PROJECT_DIR/backups" 2>/dev/null | cut -f1)
  echo -e "${BOLD}الحجم الكلي:${N} $TOTAL"
  pause
}

# ============================================================
# دالة: فتح التطبيق
# ============================================================
open_app() {
  xdg-open "http://localhost:$PORT" 2>/dev/null &
  echo -e "${G}✅ فتح التطبيق في المتصفح${N}"
  sleep 1
}

# ============================================================
# دالة: فتح لوحة المالك
# ============================================================
open_admin() {
  xdg-open "http://localhost:$PORT/admin.html" 2>/dev/null &
  echo -e "${G}✅ فتح لوحة المالك${N}"
  sleep 1
}

# ============================================================
# دالة: اختبار النظام
# ============================================================
test_system() {
  header
  echo -e "${B}🧪 اختبار شامل للنظام${N}"
  echo ""
  
  # 1. الخادم
  echo -n "1. الخادم يستجيب... "
  if curl -s --max-time 3 "http://localhost:$PORT/health" | grep -q '"ok":true'; then
    echo -e "${G}✅${N}"
  else
    echo -e "${R}❌${N}"
  fi
  
  # 2. قاعدة البيانات
  echo -n "2. قاعدة البيانات... "
  if PGPASSWORD="$DB_PASSWORD" psql -U manara -d manara_db -h localhost -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${G}✅${N}"
  else
    echo -e "${R}❌${N}"
  fi
  
  # 3. Service Worker
  echo -n "3. Service Worker... "
  if curl -s --max-time 3 "http://localhost:$PORT/service-worker.js" | grep -q "CACHE_NAME"; then
    echo -e "${G}✅${N}"
  else
    echo -e "${R}❌${N}"
  fi
  
  # 4. Manifest
  echo -n "4. Manifest (PWA)... "
  if curl -s --max-time 3 "http://localhost:$PORT/manifest.json" | grep -q "المنارة"; then
    echo -e "${G}✅${N}"
  else
    echo -e "${R}❌${N}"
  fi
  
  # 5. PM2
  echo -n "5. PM2 يعمل... "
  if pm2 jlist | grep -q '"status":"online"'; then
    echo -e "${G}✅${N}"
  else
    echo -e "${R}❌${N}"
  fi
  
  # 6. Cron Jobs
  echo -n "6. Cron Jobs نشط... "
  if crontab -l 2>/dev/null | grep -q "backup.sh"; then
    echo -e "${G}✅${N}"
  else
    echo -e "${Y}⚠️  (لم تُجدول)${N}"
  fi
  
  # 7. آخر نسخة احتياطية
  echo -n "7. آخر نسخة احتياطية... "
  LATEST=$(ls -t "$PROJECT_DIR/backups/db/"*.sql.gz 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    AGE=$(( ($(date +%s) - $(stat -c %Y "$LATEST")) / 3600 ))
    if [ $AGE -lt 25 ]; then
      echo -e "${G}✅ (منذ $AGE ساعة)${N}"
    else
      echo -e "${Y}⚠️ (منذ $AGE ساعة)${N}"
    fi
  else
    echo -e "${R}❌ (لا توجد)${N}"
  fi
  
  echo ""
  echo -e "${B}انتهى الاختبار${N}"
  pause
}

# ============================================================
# دالة: معلومات النظام
# ============================================================
show_info() {
  header
  echo -e "${B}📊 معلومات النظام${N}"
  echo ""
  echo -e "${BOLD}المشروع:${N}"
  echo -e "  المسار: $PROJECT_DIR"
  echo -e "  الحجم: $(du -sh $PROJECT_DIR 2>/dev/null | cut -f1)"
  echo ""
  echo -e "${BOLD}الخادم:${N}"
  echo -e "  Node.js: $(node --version)"
  echo -e "  npm: $(npm --version)"
  echo -e "  PM2: $(pm2 --version 2>/dev/null)"
  echo ""
  echo -e "${BOLD}قاعدة البيانات:${N}"
  echo -e "  PostgreSQL: $(psql --version 2>/dev/null | awk '{print $3}')"
  if PGPASSWORD="$DB_PASSWORD" psql -U manara -d manara_db -h localhost -tAc "SELECT COUNT(*) FROM tenants" 2>/dev/null | grep -qE '^[0-9]+$'; then
    TENANTS=$(PGPASSWORD="$DB_PASSWORD" psql -U manara -d manara_db -h localhost -tAc "SELECT COUNT(*) FROM tenants" 2>/dev/null)
    PRODUCTS=$(PGPASSWORD="$DB_PASSWORD" psql -U manara -d manara_db -h localhost -tAc "SELECT COUNT(*) FROM products" 2>/dev/null)
    echo -e "  العملاء: $TENANTS"
    echo -e "  المنتجات: $PRODUCTS"
  fi
  echo ""
  echo -e "${BOLD}الشبكة:${N}"
  echo -e "  المنفذ: $PORT"
  echo -e "  IP المحلي: $(hostname -I | awk '{print $1}')"
  echo -e "  الرابط العام: http://$(hostname -I | awk '{print $1}'):$PORT"
  pause
}

# ============================================================
# الحلقة الرئيسية
# ============================================================
main_loop() {
  while true; do
    show_menu
    read -r -p "اختر: " choice
    case $choice in
      1) start_server ;;
      2) stop_server ;;
      3) restart_server ;;
      4) show_logs ;;
      5) pm2_status ;;
      6) run_backup ;;
      7) list_backups ;;
      8) open_app ;;
      9) open_admin ;;
      10) test_system ;;
      11) show_info ;;
      0|q|exit) 
        echo -e "${G}مع السلامة 👋${N}"
        exit 0
        ;;
      *) 
        echo -e "${R}خيار غير صحيح${N}"
        sleep 1
        ;;
    esac
  done
}

# ============================================================
# الدخول
# ============================================================
case "${1:-}" in
  start) start_server; exit 0 ;;
  stop) stop_server; exit 0 ;;
  restart) restart_server; exit 0 ;;
  logs) show_logs; exit 0 ;;
  status) pm2_status; exit 0 ;;
  backup) run_backup; exit 0 ;;
  test) test_system; exit 0 ;;
  info) show_info; exit 0 ;;
  "") main_loop ;;
  *) 
    echo "الاستخدام: $0 [start|stop|restart|logs|status|backup|test|info]"
    exit 1
    ;;
esac
