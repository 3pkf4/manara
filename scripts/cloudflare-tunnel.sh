#!/bin/bash
# ============================================================
# Cloudflare Tunnel - يشغّل نفقاً تلقائياً للتطبيق
# ============================================================

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$PROJECT_DIR/logs/cloudflare.log"
URL_FILE="$PROJECT_DIR/data/public-url.txt"
PID_FILE="$PROJECT_DIR/data/cloudflare.pid"
PORT="${PORT:-3000}"

mkdir -p "$PROJECT_DIR/logs" "$PROJECT_DIR/data"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

stop_tunnel() {
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      log "🛑 إيقاف النفق القديم (PID: $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null
      sleep 2
      kill -9 "$OLD_PID" 2>/dev/null
    fi
    rm -f "$PID_FILE"
  fi
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null
  sleep 1
}

start_tunnel() {
  log "🚀 بدء Cloudflare Tunnel..."

  # لا تمسح الرابط القديم حتى يصل الجديد
  rm -f "$LOG_FILE"

  nohup cloudflared tunnel --url "http://localhost:$PORT" \
    > "$LOG_FILE" 2>&1 &

  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  log "✅ النفق بدأ (PID: $NEW_PID)"

  log "⏳ في انتظار رابط Cloudflare..."
  for i in $(seq 1 90); do
    if [ -f "$LOG_FILE" ]; then
      URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | head -1)
      if [ -n "$URL" ]; then
        echo "$URL" > "$URL_FILE"
        log "🌐 الرابط العام: $URL"
        log "✅ النفق جاهز"
        return 0
      fi
    fi
    # تحقق أن العملية لا تزال حية
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
      log "❌ العملية توقفت قبل الحصول على الرابط"
      return 1
    fi
    sleep 1
  done

  log "❌ فشل الحصول على الرابط بعد 90 ثانية"
  return 1
}

# ============================================================
# المراقبة — فقط تتحقق من العملية، لا تقتل النفق
# ============================================================
watch_loop() {
  log "👁️ بدء المراقبة..."

  # تشغيل أولي
  start_tunnel

  while true; do
    sleep 60

    # هل العملية ما زالت حية؟
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        # كل 5 دقائق فقط نتحقق من الاتصال
        if [ $(($(date +%s) % 300)) -lt 60 ]; then
          if curl -s --max-time 10 "http://localhost:$PORT/health" > /dev/null 2>&1; then
            # الخادم المحلي يعمل — لا شيء
            :
          fi
        fi
        # كل شيء جيد — انتظر
        continue
      fi
    fi

    # العملية ميتة — أعد التشغيل
    log "⚠️ النفق توقف — إعادة التشغيل..."
    start_tunnel
  done
}

case "${1:-start}" in
  start)
    stop_tunnel
    start_tunnel
    ;;
  stop)
    stop_tunnel
    log "⏹️ توقف النفق"
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        echo "✅ النفق يعمل (PID: $PID)"
        if [ -f "$URL_FILE" ]; then
          echo "🌐 الرابط: $(cat $URL_FILE)"
        else
          echo "⚠️ الرابط لم يُحفظ بعد"
        fi
        exit 0
      fi
    fi
    echo "❌ النفق متوقف"
    exit 1
    ;;
  watch)
    watch_loop
    ;;
  url)
    if [ -f "$URL_FILE" ]; then
      cat "$URL_FILE"
    fi
    ;;
  *)
    echo "الاستخدام: $0 {start|stop|status|watch|url}"
    exit 1
    ;;
esac
