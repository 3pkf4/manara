#!/bin/bash
# يفتح في نافذة بدون شريط المتصفح
google-chrome --app=http://localhost:3000 \
  --user-data-dir=$HOME/.config/manara-pos \
  --window-size=1400,900 \
  2>/dev/null || \
chromium --app=http://localhost:3000 \
  --user-data-dir=$HOME/.config/manara-pos \
  --window-size=1400,900 \
  2>/dev/null || \
firefox --new-window http://localhost:3000
