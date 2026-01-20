#!/bin/bash
# Fix the systemd service on VM
# This script stops the service, fixes the config, and restarts it

VM_USER="mandy"
VM_HOST="34.68.227.248"

echo "🔧 Fixing model-hunter service on VM..."
echo ""

# Step 1: Stop the service to break the restart loop
echo "1️⃣ Stopping service to break restart loop..."
ssh $VM_USER@$VM_HOST "sudo systemctl stop model-hunter"

# Step 2: Fix the service file
echo "2️⃣ Updating service file with correct WorkingDirectory..."
ssh $VM_USER@$VM_HOST "sudo bash -c 'cat > /etc/systemd/system/model-hunter.service << \"EOF\"
[Unit]
Description=Model Hunter Application
After=network.target

[Service]
User=mandy
WorkingDirectory=/home/mandy/InverseIFHunter/model-hunter
Environment=\"PATH=/home/mandy/InverseIFHunter/venv/bin\"
ExecStart=/home/mandy/InverseIFHunter/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF'"

# Step 3: Reload systemd
echo "3️⃣ Reloading systemd daemon..."
ssh $VM_USER@$VM_HOST "sudo systemctl daemon-reload"

# Step 4: Start the service
echo "4️⃣ Starting service..."
ssh $VM_USER@$VM_HOST "sudo systemctl start model-hunter"

# Step 5: Check status
echo ""
echo "5️⃣ Checking service status..."
sleep 2
ssh $VM_USER@$VM_HOST "sudo systemctl status model-hunter --no-pager -l | head -20"

echo ""
echo "✅ Done! Service should now be running correctly."
echo ""
echo "To check logs: ssh $VM_USER@$VM_HOST 'sudo journalctl -u model-hunter -f'"
