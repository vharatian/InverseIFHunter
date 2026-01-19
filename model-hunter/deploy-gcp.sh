#!/bin/bash
# Model Hunter - GCP Cloud Run Deployment Script
# 
# Prerequisites:
# 1. gcloud CLI installed and authenticated
# 2. A GCP project with Cloud Run API enabled
# 3. Docker installed (for local testing)

set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-your-project-id}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="model-hunter"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "🚀 Model Hunter - Cloud Run Deployment"
echo "======================================="
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Service: $SERVICE_NAME"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Please install it first."
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &> /dev/null; then
    echo "❌ Not authenticated. Run: gcloud auth login"
    exit 1
fi

# Set project
echo "📦 Setting project..."
gcloud config set project $PROJECT_ID

# Enable required APIs
echo "🔧 Enabling required APIs..."
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com

# Build and push the container
echo "🐳 Building container..."
gcloud builds submit --tag $IMAGE_NAME

# Deploy to Cloud Run
echo "☁️ Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
    --image $IMAGE_NAME \
    --platform managed \
    --region $REGION \
    --allow-unauthenticated \
    --set-env-vars "OPENAI_API_KEY=${OPENAI_API_KEY}" \
    --set-env-vars "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    --memory 512Mi \
    --timeout 300 \
    --concurrency 10

# Get the service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)")

echo ""
echo "✅ Deployment complete!"
echo "🔗 URL: $SERVICE_URL"
echo ""
echo "⚠️ Note: Set your API keys as environment variables before running:"
echo "   export OPENAI_API_KEY=your-key"
echo "   export OPENROUTER_API_KEY=your-key"
echo "   export GCP_PROJECT_ID=your-project-id"
