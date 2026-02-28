#!/bin/bash
# Verify that the latest code is deployed on the VM

VM_USER="mandy"
VM_HOST="34.68.227.248"
VM_PATH="/home/mandy/InverseIFHunter/model-hunter"

echo "🔍 Verifying Deployment"
echo "======================"
echo ""

# Get latest commit hash from GitHub
echo "📋 Latest commit on GitHub:"
LATEST_COMMIT=$(git log -1 --format="%H %s" 2>/dev/null || echo "Could not determine")
echo "   $LATEST_COMMIT"
echo ""

# Check VM commit hash
echo "📋 Checking VM deployment..."
ssh ${VM_USER}@${VM_HOST} << 'ENDSSH'
    cd /home/mandy/InverseIFHunter/model-hunter
    
    echo "📍 Current commit on VM:"
    git log -1 --format="%H %s" || echo "   Could not determine"
    echo ""
    
    echo "📅 File modification times:"
    echo "   main.py: $(stat -c %y main.py 2>/dev/null || stat -f %Sm main.py 2>/dev/null || echo 'unknown')"
    echo "   services/notebook_parser.py: $(stat -c %y services/notebook_parser.py 2>/dev/null || stat -f %Sm services/notebook_parser.py 2>/dev/null || echo 'unknown')"
    echo "   static/app.js: $(stat -c %y static/app.js 2>/dev/null || stat -f %Sm static/app.js 2>/dev/null || echo 'unknown')"
    echo ""
    
    echo "🔍 Checking for new code features:"
    
    # Check for composite key feature in app.js
    if grep -q "hunt_id:slotNum\|uniqueKey.*hunt_id.*currentSlotNum" static/app.js 2>/dev/null; then
        echo "   ✅ Composite key feature found in app.js"
    else
        echo "   ❌ Composite key feature NOT found in app.js"
    fi
    
    # Check for slotNum mapping in notebook_parser.py
    if grep -q "Use slotNum from the review\|hunt_id:slotNum" services/notebook_parser.py 2>/dev/null; then
        echo "   ✅ slotNum mapping feature found in notebook_parser.py"
    else
        echo "   ❌ slotNum mapping feature NOT found in notebook_parser.py"
    fi
    
    # Check for snapshot_service.py
    if [ -f "services/snapshot_service.py" ]; then
        echo "   ✅ snapshot_service.py exists"
    else
        echo "   ❌ snapshot_service.py NOT found"
    fi
    
    echo ""
    echo "🔄 Service status:"
    sudo systemctl status model-hunter --no-pager -l | head -15 || echo "   ⚠️  Could not check service status (needs sudo)"
    
    echo ""
    echo "📊 Recent service logs (last 10 lines):"
    sudo journalctl -u model-hunter -n 10 --no-pager || echo "   ⚠️  Could not check logs (needs sudo)"
ENDSSH

echo ""
echo "✅ Verification complete!"
echo ""
echo "To see live logs, run:"
echo "  ssh ${VM_USER}@${VM_HOST} 'sudo journalctl -u model-hunter -f'"
