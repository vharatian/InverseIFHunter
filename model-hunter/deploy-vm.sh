#!/bin/bash
# Model Hunter - VM Deployment Script
# Deploys the latest code from GitHub to the VM

set -e

VM_USER="mandy"
VM_HOST="34.68.227.248"
VM_PATH="/home/mandy/InverseIFHunter"
SERVICE_NAME="model-hunter"

echo "🚀 Model Hunter - VM Deployment"
echo "================================="
echo "VM: ${VM_USER}@${VM_HOST}"
echo "Path: ${VM_PATH}"
echo ""

# Check if SSH key is available
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 ${VM_USER}@${VM_HOST} exit 2>/dev/null; then
    echo "❌ Cannot connect to VM. Please ensure:"
    echo "   1. SSH key is set up"
    echo "   2. VM is accessible"
    echo "   3. You have access to ${VM_USER}@${VM_HOST}"
    exit 1
fi

echo "✅ Connected to VM"
echo ""

# Deploy via SSH
echo "📥 Pulling latest code from GitHub..."
ssh ${VM_USER}@${VM_HOST} << 'ENDSSH'
    set -e
    cd /home/mandy/InverseIFHunter
    echo "Current directory: $(pwd)"
    echo "Current branch: $(git branch --show-current)"
    echo ""
    
    # Pull latest code
    echo "🔄 Pulling latest changes..."
    git pull origin master
    
    echo ""
    echo "📦 Checking Python dependencies..."
    cd model-hunter
    
    # Activate venv and update dependencies if needed
    if [ -d "../venv" ]; then
        source ../venv/bin/activate
        echo "✅ Virtual environment activated"
        
        # Check if requirements changed
        if [ -f "requirements.txt" ]; then
            echo "📋 Installing/updating dependencies..."
            pip install -q -r requirements.txt
        fi
    else
        echo "⚠️  Virtual environment not found at ../venv"
        echo "   Please create it manually if needed"
    fi
    
    echo ""
    echo "🔄 Restarting service..."
    # Try without password first (if passwordless sudo is configured)
    if sudo -n systemctl restart model-hunter 2>/dev/null; then
        echo "✅ Service restarted (passwordless sudo)"
    else
        echo "⚠️  Password required for sudo. Please run manually:"
        echo "   sudo systemctl restart model-hunter"
        echo ""
        echo "   Or configure passwordless sudo for systemctl commands"
    fi
    
    echo ""
    echo "⏳ Waiting for service to start..."
    sleep 3
    
    echo ""
    echo "📊 Service status:"
    sudo -n systemctl status model-hunter --no-pager -l 2>/dev/null || echo "⚠️  Run 'sudo systemctl status model-hunter' manually to check status"
    
    echo ""
    echo "✅ Deployment complete!"
ENDSSH

echo ""
echo "🎉 Deployment finished!"
echo ""
echo "To check logs, run:"
echo "  ssh ${VM_USER}@${VM_HOST} 'sudo journalctl -u ${SERVICE_NAME} -f'"
echo ""
echo "To check service status, run:"
echo "  ssh ${VM_USER}@${VM_HOST} 'sudo systemctl status ${SERVICE_NAME}'"
echo ""
