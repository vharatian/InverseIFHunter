#!/bin/bash
# Setup systemd service for Model Hunter
# Run with: sudo bash setup-service.sh

set -e

SERVICE_FILE="/etc/systemd/system/model-hunter.service"

echo "Creating systemd service file..."

cat > "$SERVICE_FILE" << 'EOF'
[Unit]
Description=Model Hunter Application
After=network.target

[Service]
User=mandy
WorkingDirectory=/home/mandy/InverseIFHunter/model-hunter
Environment="PATH=/home/mandy/InverseIFHunter/venv/bin"
ExecStart=/home/mandy/InverseIFHunter/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling model-hunter service (auto-start on boot)..."
systemctl enable model-hunter

echo "Stopping any existing uvicorn processes..."
pkill -f uvicorn || true
sleep 2

echo "Starting model-hunter service..."
systemctl start model-hunter

echo ""
echo "✅ Service setup complete!"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status model-hunter   # Check status"
echo "  sudo systemctl restart model-hunter  # Restart"
echo "  sudo journalctl -u model-hunter -f   # View logs"
echo ""

systemctl status model-hunter --no-pager
