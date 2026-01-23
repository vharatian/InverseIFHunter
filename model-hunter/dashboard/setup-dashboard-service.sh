#!/bin/bash
# Setup systemd service for Model Hunter Dashboard
# Run with: sudo bash dashboard/setup-dashboard-service.sh

set -e

SERVICE_FILE="/etc/systemd/system/model-hunter-dashboard.service"
NGINX_CONF="/etc/nginx/sites-available/default"

echo "========================================="
echo "Model Hunter Dashboard - Service Setup"
echo "========================================="
echo ""

# Create dashboard systemd service
echo "1. Creating systemd service file..."

cat > "$SERVICE_FILE" << 'EOF'
[Unit]
Description=Model Hunter Dashboard
After=network.target model-hunter.service

[Service]
User=mandy
WorkingDirectory=/home/mandy/InverseIFHunter/model-hunter/dashboard
Environment="PATH=/home/mandy/InverseIFHunter/venv/bin"
Environment="TELEMETRY_LOG_PATH=/home/mandy/InverseIFHunter/model-hunter/.telemetry/events.jsonl"
ExecStart=/home/mandy/InverseIFHunter/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "   ✅ Service file created"

# Create telemetry directory
echo ""
echo "2. Creating telemetry directory..."
mkdir -p /home/mandy/InverseIFHunter/model-hunter/.telemetry
chown mandy:mandy /home/mandy/InverseIFHunter/model-hunter/.telemetry
echo "   ✅ Telemetry directory created"

# Reload systemd
echo ""
echo "3. Reloading systemd daemon..."
systemctl daemon-reload
echo "   ✅ Daemon reloaded"

# Enable and start dashboard service
echo ""
echo "4. Enabling and starting dashboard service..."
systemctl enable model-hunter-dashboard
systemctl start model-hunter-dashboard
echo "   ✅ Dashboard service started"

echo ""
echo "========================================="
echo "5. NGINX Configuration Required"
echo "========================================="
echo ""
echo "Add this to your nginx config (usually /etc/nginx/sites-available/default):"
echo ""
echo "    # Dashboard - monitoring UI"
echo "    location /dashboard/ {"
echo "        proxy_pass http://127.0.0.1:8001/;"
echo "        proxy_http_version 1.1;"
echo "        proxy_set_header Host \$host;"
echo "        proxy_set_header X-Real-IP \$remote_addr;"
echo "        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
echo "    }"
echo ""
echo "    location /dashboard/api/ {"
echo "        proxy_pass http://127.0.0.1:8001/api/;"
echo "        proxy_http_version 1.1;"
echo "        proxy_set_header Host \$host;"
echo "    }"
echo ""
echo "    location /dashboard/static/ {"
echo "        proxy_pass http://127.0.0.1:8001/static/;"
echo "        proxy_http_version 1.1;"
echo "    }"
echo ""
echo "Then reload nginx: sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "========================================="
echo ""
echo "✅ Dashboard service setup complete!"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status model-hunter-dashboard   # Check status"
echo "  sudo systemctl restart model-hunter-dashboard  # Restart"
echo "  sudo journalctl -u model-hunter-dashboard -f   # View logs"
echo ""
echo "Dashboard will be available at: http://your-vm-ip/dashboard/"
echo ""
