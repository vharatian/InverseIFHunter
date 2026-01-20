# Deploy to VM - Step by Step Guide

## Step 1: Push Changes to GitHub

### 1.1 Stage and Commit Your Changes

```bash
cd /Users/maruthimanideepgorla/Desktop/website_generation

# Add the modified file
git add model-hunter/services/openai_client.py

# Optionally add the testing guide (useful for documentation)
git add model-hunter/LOCAL_TESTING.md

# Commit with a descriptive message
git commit -m "Update judge prompt template format: fix Standard Responses section and separators"
```

### 1.2 Push to GitHub

```bash
# Push to master branch
git push origin master

# Or if you're on a different branch:
# git push origin your-branch-name
```

## Step 2: Deploy to VM

### 2.1 SSH into the VM

```bash
ssh mandy@34.68.227.248
```

### 2.2 Stop the Service (to prevent issues during update)

```bash
sudo systemctl stop model-hunter
```

### 2.3 Navigate to Project Directory

```bash
cd InverseIFHunter/model-hunter
```

### 2.4 Pull Latest Changes from GitHub

```bash
# Pull the latest code
git pull origin master

# Or if you pushed to a different branch:
# git pull origin your-branch-name
```

### 2.5 Verify Changes

```bash
# Check that the file was updated
git log --oneline -5
git diff HEAD~1 model-hunter/services/openai_client.py | head -50
```

### 2.6 Restart the Service

```bash
# Restart the service to apply changes
sudo systemctl restart model-hunter

# Check status
sudo systemctl status model-hunter

# View logs to ensure it started correctly
sudo journalctl -u model-hunter -n 50 --no-pager
```

### 2.7 Verify Deployment

```bash
# Check if the service is running
curl http://localhost:8000/health

# Or check the service status
sudo systemctl status model-hunter
```

## Quick One-Liner Deployment (After SSH)

If you want to do it all at once after SSHing in:

```bash
sudo systemctl stop model-hunter && \
cd InverseIFHunter/model-hunter && \
git pull origin master && \
sudo systemctl start model-hunter && \
sudo systemctl status model-hunter
```

## Troubleshooting

### If service fails to start:

```bash
# Check logs for errors
sudo journalctl -u model-hunter -n 100 --no-pager

# Check if port is in use
sudo lsof -i :8000

# Restart manually if needed
cd /home/mandy/InverseIFHunter/model-hunter
source venv/bin/activate
python main.py  # Test manually first
```

### If git pull fails:

```bash
# Check for uncommitted changes on VM
git status

# If there are local changes, stash them
git stash

# Then pull again
git pull origin master
```

### To view real-time logs:

```bash
sudo journalctl -u model-hunter -f
```

## Rollback (if needed)

If something goes wrong and you need to rollback:

```bash
cd InverseIFHunter/model-hunter
git log --oneline -10  # Find the previous commit
git checkout <previous-commit-hash>
sudo systemctl restart model-hunter
```

Or revert to the previous version:

```bash
git revert HEAD
git pull origin master
sudo systemctl restart model-hunter
```
