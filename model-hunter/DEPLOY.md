# Model Hunter - GCP Cloud Run Deployment Guide

## Quick Deploy

### Prerequisites
1. [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed
2. A GCP project with billing enabled
3. Your API keys ready:
   - `OPENAI_API_KEY`
   - `OPENROUTER_API_KEY`

### Option 1: Using Deploy Script

```bash
# Set environment variables
export GCP_PROJECT_ID=your-project-id
export OPENAI_API_KEY=your-openai-key
export OPENROUTER_API_KEY=your-openrouter-key

# Run deploy script
chmod +x deploy-gcp.sh
./deploy-gcp.sh
```

### Option 2: Manual Deployment

```bash
# 1. Authenticate with GCP
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# 2. Enable required APIs
gcloud services enable run.googleapis.com containerregistry.googleapis.com

# 3. Build and push container
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/model-hunter

# 4. Deploy to Cloud Run
gcloud run deploy model-hunter \
  --image gcr.io/YOUR_PROJECT_ID/model-hunter \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "OPENAI_API_KEY=your-key,OPENROUTER_API_KEY=your-key" \
  --memory 512Mi
```

## Environment Variables

Set these in Cloud Run console or via CLI:

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for GPT-5 judge |
| `OPENROUTER_API_KEY` | OpenRouter API key for model calls |

## Google Drive Integration

For the "Save to Drive" feature to work in production:

1. Create a GCP service account with Drive API access
2. Download the JSON key file
3. Either:
   - Set `GOOGLE_SERVICE_ACCOUNT_JSON` env var with the JSON content
   - Or mount the file as a secret volume

## Estimated Costs

Cloud Run pricing (pay-per-use):
- ~$0.00002400 per vCPU-second
- ~$0.00000250 per GiB-second
- First 2 million requests/month free

For occasional use: **< $5/month**
