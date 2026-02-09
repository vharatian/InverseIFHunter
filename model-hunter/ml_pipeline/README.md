# 🎯 Model Hunter ML Pipeline

Complete ML analytics pipeline for Model Hunter data analysis.

## 📁 Files Overview

```
ml_pipeline/
├── export_ml_data.py          # Data export script (run on VM)
├── run_export.sh              # Quick export script for VM
├── cron_daily_export.sh       # Daily automated export
├── Model_Hunter_ML_Analysis.ipynb  # Google Colab notebook
└── README.md                  # This file
```

## 🚀 Quick Start

### Step 1: Export Data from VM

SSH into your VM and run:

```bash
# Copy the ml_pipeline folder to VM
scp -r ml_pipeline/ mandy@YOUR_VM_IP:~/InverseIFHunter/model-hunter/

# SSH to VM
ssh mandy@YOUR_VM_IP

# Run export
cd ~/InverseIFHunter/model-hunter
chmod +x ml_pipeline/run_export.sh
./ml_pipeline/run_export.sh
```

### Step 2: Download to Your Machine

```bash
# From your local machine
scp -r mandy@YOUR_VM_IP:/tmp/ml_export/ ./ml_data/
```

### Step 3: Upload to Google Colab

1. Open `Model_Hunter_ML_Analysis.ipynb` in Google Colab
2. Upload the exported files when prompted
3. Run all cells

## 📊 What Gets Exported

| File | Description | Size (est.) |
|------|-------------|-------------|
| `ml_dataset.jsonl.gz` | Complete ML dataset with prompts, outcomes, criteria | ~10-50 MB |
| `trainer_leaderboard.csv` | Trainer rankings and stats | ~50 KB |
| `criteria_difficulty.csv` | Criteria pass/fail analysis | ~20 KB |
| `model_performance.csv` | Model comparison data | ~5 KB |
| `api_timing.csv` | API latency data | ~5 MB |

## 🧠 ML Predictions Available

### 1. Break Prediction
- **Input**: Prompt + criteria features
- **Output**: Probability of finding breaks
- **Use case**: Prioritize hard tasks

### 2. Criteria Difficulty Ranking
- **Input**: Historical criteria results
- **Output**: Ranked criteria by fail rate
- **Use case**: Focus review on hard criteria

### 3. Model Comparison
- **Input**: Model performance data
- **Output**: Best model for breaking
- **Use case**: Optimize model selection

### 4. Time/Cost Estimation
- **Input**: Task features
- **Output**: Expected duration and cost
- **Use case**: Resource planning

### 5. Trainer Leaderboard
- **Input**: Session and hunt data
- **Output**: Ranked trainers by effectiveness
- **Use case**: Recognize top performers

## ⚙️ Automated Daily Export

To run exports automatically every day:

```bash
# On VM, add to crontab
crontab -e

# Add this line (runs at 2 AM daily)
0 2 * * * /home/mandy/InverseIFHunter/model-hunter/ml_pipeline/cron_daily_export.sh
```

## 🔧 Configuration

### Environment Variables (VM)

```bash
# In docker-compose.yml or .env
TELEMETRY_LOG_PATH=/app/.telemetry/events.jsonl
SESSION_STORAGE_PATH=/app/.storage
```

### Export Paths

```bash
# Default output directory
/tmp/ml_export/

# Custom output
python ml_pipeline/export_ml_data.py --output /custom/path/
```

## 📈 Dashboard Enhancement

The enhanced dashboard (`dashboard/main_enhanced.py`) adds:

- 🏆 Trainer Leaderboard
- 📋 Criteria Difficulty Analysis
- 🔥 Activity Heatmap
- ⚡ Real-time Stats (5-minute window)

### Running Enhanced Dashboard

```bash
# In Docker (modify docker-compose.yml)
python dashboard/main_enhanced.py

# Or update the dashboard service to use main_enhanced.py
```

## 🔄 Workflow Summary

```
┌─────────────────────────────────────────────────────────────┐
│                         VM (Production)                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │   Model     │───▶│  Telemetry  │───▶│   Export    │      │
│  │   Hunter    │    │    Logs     │    │   Script    │      │
│  └─────────────┘    └─────────────┘    └──────┬──────┘      │
└───────────────────────────────────────────────│──────────────┘
                                                │
                                     Download   │
                                                ▼
┌─────────────────────────────────────────────────────────────┐
│                      Google Colab                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐      │
│  │   Upload    │───▶│   ML        │───▶│  Insights   │      │
│  │   Data      │    │   Analysis  │    │  & Reports  │      │
│  └─────────────┘    └─────────────┘    └─────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## 🆘 Troubleshooting

### Export fails with "No storage directory"
- Check `SESSION_STORAGE_PATH` environment variable
- Verify Docker volume mounts

### Colab notebook can't read files
- Make sure to upload `.gz` file (compressed)
- Check file names match expected names

### Missing trainer data
- Trainer IDs are extracted from Colab URLs
- Sessions without URLs use filename hash

## 📝 Notes

- Data is exported from the **green** (active) container
- Telemetry logs rotate every 7 days
- Session storage persists indefinitely (watch disk space)
- Cost estimates use hardcoded pricing - may differ from actual billing
