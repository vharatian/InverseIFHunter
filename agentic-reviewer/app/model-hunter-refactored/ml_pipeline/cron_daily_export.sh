#!/bin/bash
# Daily ML data export cron job
# Add to crontab: 0 4 * * * /home/mandy/InverseIFHunter/model-hunter/ml_pipeline/cron_daily_export.sh
#
# This runs at 4 AM daily and uploads to Google Drive (if configured)

set -e

LOG_FILE="/var/log/ml_export.log"
EXPORT_DIR="/tmp/ml_export_daily"
TIMESTAMP=$(date +%Y%m%d)
ARCHIVE_NAME="ml_export_${TIMESTAMP}.tar.gz"

echo "$(date): Starting daily ML export" >> ${LOG_FILE}

# Clean and create export directory
rm -rf ${EXPORT_DIR}
mkdir -p ${EXPORT_DIR}

# Run export
docker exec model-hunter-green python /app/ml_pipeline/export_ml_data.py \
    --storage /app/.storage \
    --telemetry /app/.telemetry/events.jsonl \
    --output ${EXPORT_DIR} >> ${LOG_FILE} 2>&1

# Copy from container
docker cp model-hunter-green:${EXPORT_DIR}/. ${EXPORT_DIR}/

# Create archive
cd /tmp
tar -czf ${ARCHIVE_NAME} -C /tmp ml_export_daily/

# Keep only last 7 days of exports
find /tmp -name "ml_export_*.tar.gz" -mtime +7 -delete

echo "$(date): Export complete - /tmp/${ARCHIVE_NAME}" >> ${LOG_FILE}

# Optional: Upload to Google Drive using rclone (if configured)
# Uncomment below if you set up rclone with Google Drive
# rclone copy /tmp/${ARCHIVE_NAME} gdrive:ModelHunter/ml_exports/

echo "$(date): Daily export finished" >> ${LOG_FILE}
