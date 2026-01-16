#!/bin/bash
# Safe script to update API keys in .env file
# This script helps you add/update API keys without exposing them in command history

set -e

ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

echo "🔑 API Key Update Script"
echo "========================"
echo ""

# Check if .env exists, if not create from example
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ENV_EXAMPLE" ]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        echo "✅ Created $ENV_FILE from $ENV_EXAMPLE"
    else
        touch "$ENV_FILE"
        echo "✅ Created new $ENV_FILE"
    fi
fi

# Function to update or add environment variable
update_env_var() {
    local key=$1
    local value=$2
    
    # Remove existing line if present
    if grep -q "^${key}=" "$ENV_FILE"; then
        # Use sed to update (works on both macOS and Linux)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
        else
            sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
        fi
        echo "✅ Updated $key"
    else
        # Append new line
        echo "${key}=${value}" >> "$ENV_FILE"
        echo "✅ Added $key"
    fi
}

# Prompt for OpenAI API Key
echo "📝 OpenAI API Key"
echo "Enter your new OpenAI API key (or press Enter to skip):"
read -s OPENAI_KEY
if [ ! -z "$OPENAI_KEY" ]; then
    update_env_var "OPENAI_API_KEY" "$OPENAI_KEY"
fi
echo ""

# Prompt for Fireworks API Key
echo "📝 Fireworks AI API Key"
echo "Enter your Fireworks AI API key (or press Enter to skip):"
read -s FIREWORKS_KEY
if [ ! -z "$FIREWORKS_KEY" ]; then
    update_env_var "FIREWORKS_API_KEY" "$FIREWORKS_KEY"
fi
echo ""

# Prompt for OpenRouter API Key (optional, in case they want to update it too)
echo "📝 OpenRouter API Key (optional)"
echo "Enter your OpenRouter API key (or press Enter to skip):"
read -s OPENROUTER_KEY
if [ ! -z "$OPENROUTER_KEY" ]; then
    update_env_var "OPENROUTER_API_KEY" "$OPENROUTER_KEY"
fi
echo ""

echo ""
echo "✅ API keys updated in $ENV_FILE"
echo "⚠️  Make sure $ENV_FILE is in .gitignore and never commit it!"
echo ""
echo "To verify, you can check the file (keys will be visible):"
echo "  cat $ENV_FILE"
echo ""
echo "To apply changes, restart your application/service."

