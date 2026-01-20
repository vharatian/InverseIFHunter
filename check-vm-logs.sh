#!/bin/bash
# Helper script to check VM logs
# Usage: ./check-vm-logs.sh [broken-pipe|all|nginx|status]

VM_USER="mandy"
VM_HOST="34.68.227.248"

case "${1:-all}" in
    broken-pipe)
        echo "🔍 Searching for 'Broken pipe' errors..."
        ssh $VM_USER@$VM_HOST "sudo journalctl -u model-hunter --no-pager | grep -i 'broken pipe' | tail -20"
        ;;
    nginx)
        echo "📋 Nginx Error Logs (last 30 lines):"
        ssh $VM_USER@$VM_HOST "sudo tail -30 /var/log/nginx/error.log"
        echo ""
        echo "📋 Nginx Access Logs (last 30 lines):"
        ssh $VM_USER@$VM_HOST "sudo tail -30 /var/log/nginx/access.log"
        ;;
    status)
        echo "📊 Service Status:"
        ssh $VM_USER@$VM_HOST "sudo systemctl status model-hunter --no-pager -l | head -20"
        ;;
    all|*)
        echo "📊 Service Status:"
        ssh $VM_USER@$VM_HOST "sudo systemctl status model-hunter --no-pager -l | head -15"
        echo ""
        echo "📋 Recent Application Logs (last 50 lines):"
        ssh $VM_USER@$VM_HOST "sudo journalctl -u model-hunter -n 50 --no-pager"
        echo ""
        echo "🔍 Recent Errors:"
        ssh $VM_USER@$VM_HOST "sudo journalctl -u model-hunter --since '1 hour ago' --no-pager | grep -i 'error\|exception\|failed' | tail -20"
        ;;
esac

