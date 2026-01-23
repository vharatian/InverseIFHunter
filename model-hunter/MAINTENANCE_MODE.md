# Maintenance Mode - The Door System 🚪

A sarcastic, trainer-friendly maintenance page that can be toggled on/off easily.

## How It Works

When maintenance mode is **enabled**, users visiting the site see a beautiful door animation with sarcastic messages about server downtime. Trainers can "open the door" to access the app and work normally, then "close the door" when done.

## Setting Up Your Secret Key

**IMPORTANT:** Only you (the admin) can toggle the door. Set your secret key:

```bash
# Add to .env file
echo "MAINTENANCE_SECRET=your-secret-key-here" >> .env

# Or export as environment variable
export MAINTENANCE_SECRET=your-secret-key-here
```

## Enabling Maintenance Mode

### Method 1: Shell Script (Easiest - No Auth Required)
```bash
# Enable maintenance (close door)
./toggle-maintenance.sh on

# Disable maintenance (open door)
./toggle-maintenance.sh off

# Check status
./toggle-maintenance.sh status
```

### Method 2: API Endpoint (Requires Secret)
```bash
# Toggle maintenance mode (requires MAINTENANCE_SECRET)
curl -X POST http://localhost:8000/api/toggle-maintenance \
  -H "Content-Type: application/json" \
  -d '{"secret": "your-secret-key-here"}'

# Check status
curl http://localhost:8000/api/maintenance-status
```

### Method 3: Environment Variable
```bash
export MAINTENANCE_MODE=true
# Restart server
```

### Method 4: Create File Manually
```bash
touch .maintenance
# Server will detect it automatically
```

## Disabling Maintenance Mode

### Method 1: Shell Script
```bash
./toggle-maintenance.sh off
```

### Method 2: API Endpoint
```bash
curl -X POST http://localhost:8000/api/toggle-maintenance
```

### Method 3: Remove File
```bash
rm .maintenance
```

### Method 4: Environment Variable
```bash
unset MAINTENANCE_MODE
# Or set to false
export MAINTENANCE_MODE=false
```

## Opening the Door (Admin Only)

When maintenance mode is active, **only you (the admin)** can open the door:

1. **Visit the maintenance page**
2. **Enter your secret key** in the authentication field
3. **Click "Unlock"** or press Enter
4. **Once authenticated**, you can:
   - Click the door knob
   - Click the "Open the Door" button

This will:
- Verify your secret key
- Disable maintenance mode via API
- Show the door opening animation
- Redirect to the main app
- Store authentication in session (so you don't need to re-enter)

**Note:** Regular trainers will see the maintenance page but cannot open the door without your secret key.

## The Door UI

- **Closed Door**: Shows maintenance message with sarcastic humor
- **Open Door**: Shows "Server Active" message
- **Door Knob**: Clickable element to toggle
- **Toggle Button**: Large button to open/close door
- **Animations**: Smooth 3D door rotation with stars background

## Files

- `static/maintenance.html` - The maintenance page with door UI
- `toggle-maintenance.sh` - Shell script for easy toggling
- `.maintenance` - Flag file (created when enabled, removed when disabled)
- `main.py` - Backend routes for maintenance mode

## Example Workflow

1. **Before deployment:**
   ```bash
   ./toggle-maintenance.sh on
   ```
   Users see maintenance page.

2. **During work:**
   - Open maintenance page
   - Click door knob or button
   - Work normally in the app

3. **After work:**
   - Click door knob/button again to close
   - Or run: `./toggle-maintenance.sh off`

## Notes

- The `.maintenance` file is gitignored (won't be committed)
- Maintenance mode is checked on every root route (`/`) request
- The door animation is purely visual - the actual toggle happens via API
- Multiple trainers can work simultaneously (maintenance mode is global)
