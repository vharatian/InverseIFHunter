#!/bin/bash
# Toggle maintenance mode for Model Hunter
# Usage: ./toggle-maintenance.sh [on|off|status]
# Note: This script toggles via file, which works without authentication.
# For API access, you need MAINTENANCE_SECRET environment variable.

MAINTENANCE_FILE=".maintenance"

case "$1" in
    on)
        touch "$MAINTENANCE_FILE"
        echo "🔧 Maintenance mode ENABLED - Door is closed!"
        echo "   Users will see the maintenance page."
        ;;
    off)
        if [ -f "$MAINTENANCE_FILE" ]; then
            rm "$MAINTENANCE_FILE"
            echo "✅ Maintenance mode DISABLED - Door is open!"
            echo "   Users can access the app normally."
        else
            echo "⚠️  Maintenance mode was already disabled."
        fi
        ;;
    status)
        if [ -f "$MAINTENANCE_FILE" ]; then
            echo "🔧 Maintenance mode: ENABLED (Door closed)"
        else
            echo "✅ Maintenance mode: DISABLED (Door open)"
        fi
        ;;
    *)
        echo "Usage: $0 [on|off|status]"
        echo ""
        echo "Commands:"
        echo "  on     - Enable maintenance mode (close door)"
        echo "  off    - Disable maintenance mode (open door)"
        echo "  status - Check current maintenance mode status"
        exit 1
        ;;
esac
