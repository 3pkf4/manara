#!/bin/bash
# ============================================================
# مشغّل المنارة POS
# ============================================================

PORT=3000
URL="http://localhost:$PORT"

# تحقق أن الخادم يعمل
if ! curl -s --max-time 2 "$URL/health" | grep -q '"ok":true'; then
  # حاول تشغيله
  if ! pm2 jlist 2>/dev/null | grep -q '"name":"manara-pos"'; then
    cd /home/mohammed/manara-saas
    pm2 start ecosystem.config.js
    sleep 3
  fi
fi

# افتح المتصفح
xdg-open "$URL" 2>/dev/null &

exit 0
