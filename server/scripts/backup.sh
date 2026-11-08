#!/usr/bin/env bash
# نسخ احتياطي لقاعدة البيانات — يقرأ الإعدادات من .env (لا أسرار داخل السكربت)
# اختياري: BACKUP_GPG_RECIPIENT=مفتاح  لتشفير النسخة،  BACKUP_RCLONE_REMOTE=remote:path  لرفعها خارج الجهاز
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
set -a; . "$PROJECT_DIR/.env"; set +a

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR/db"
chmod 700 "$BACKUP_DIR"

OUT="$BACKUP_DIR/db/${DB_NAME}_${TS}.sql.gz"
PGPASSWORD="${DB_PASSWORD:-}" pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-acl --clean --if-exists | gzip > "$OUT"
chmod 600 "$OUT"

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always -e -r "$BACKUP_GPG_RECIPIENT" -o "$OUT.gpg" "$OUT" && rm -f "$OUT" && OUT="$OUT.gpg"
fi
echo "✅ $OUT ($(du -h "$OUT" | cut -f1))"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE" && echo "☁️  رُفعت إلى $BACKUP_RCLONE_REMOTE"
fi

find "$BACKUP_DIR/db" -type f \( -name '*.sql.gz' -o -name '*.sql.gz.gpg' \) -mtime +"$RETENTION_DAYS" -delete
# ملاحظة: لا نضع ملف .env في النسخ الاحتياطية (يحوي الأسرار)
