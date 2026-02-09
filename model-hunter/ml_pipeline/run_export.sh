#!/bin/bash
# Run ML data export on VM
# Usage: ./run_export.sh

set -e

EXPORT_DIR="/tmp/ml_export"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_NAME="ml_export_${TIMESTAMP}.tar.gz"

echo "🚀 Model Hunter ML Data Export"
echo "=============================="
echo ""

# Clean previous export
rm -rf ${EXPORT_DIR}
mkdir -p ${EXPORT_DIR}

# Run export inside the green container (active one)
echo "📦 Running export in Docker container..."
docker exec model-hunter-green python /app/ml_pipeline/export_ml_data.py \
    --storage /app/.storage \
    --telemetry /app/.telemetry/events.jsonl \
    --output ${EXPORT_DIR}

# Copy files out of container to host
echo ""
echo "📤 Copying files from container to host..."
docker cp model-hunter-green:${EXPORT_DIR}/. ${EXPORT_DIR}/

# Create archive
echo ""
echo "📁 Creating archive..."
cd /tmp
tar -czvf ${ARCHIVE_NAME} ml_export/

echo ""
echo "✅ Export complete!"
echo ""
echo "📥 Download to your machine with:"
echo "   scp mandy@$(hostname -I | awk '{print $1}'):/tmp/${ARCHIVE_NAME} ./"
echo ""
echo "Or download individual files:"
echo "   scp mandy@$(hostname -I | awk '{print $1}'):${EXPORT_DIR}/* ./"
echo ""
echo "📊 Then upload to Google Colab or Google Drive"
