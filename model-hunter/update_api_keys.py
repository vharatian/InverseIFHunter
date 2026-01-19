#!/usr/bin/env python3
"""
Safe script to update API keys in .env file.
Uses getpass for secure input (keys won't show in terminal).
"""

import os
import re
from getpass import getpass
from pathlib import Path

ENV_FILE = Path(".env")
ENV_EXAMPLE = Path(".env.example")

def update_env_var(key: str, value: str):
    """Update or add an environment variable in .env file."""
    if not ENV_FILE.exists():
        # Create from example if it exists
        if ENV_EXAMPLE.exists():
            ENV_FILE.write_text(ENV_EXAMPLE.read_text())
            print(f"✅ Created {ENV_FILE} from {ENV_EXAMPLE}")
        else:
            ENV_FILE.touch()
            print(f"✅ Created new {ENV_FILE}")
    
    content = ENV_FILE.read_text()
    
    # Pattern to match the key (handles various formats)
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    
    new_line = f"{key}={value}\n"
    
    if pattern.search(content):
        # Update existing
        content = pattern.sub(new_line.rstrip(), content)
        ENV_FILE.write_text(content)
        print(f"✅ Updated {key}")
    else:
        # Append new
        if not content.endswith('\n'):
            content += '\n'
        content += new_line
        ENV_FILE.write_text(content)
        print(f"✅ Added {key}")

def main():
    print("🔑 API Key Update Script")
    print("=" * 50)
    print()
    
    # OpenAI API Key
    print("📝 OpenAI API Key")
    print("Enter your new OpenAI API key (or press Enter to skip):")
    openai_key = getpass("").strip()
    if openai_key:
        update_env_var("OPENAI_API_KEY", openai_key)
    print()
    
    # Fireworks API Key
    print("📝 Fireworks AI API Key")
    print("Enter your Fireworks AI API key (or press Enter to skip):")
    fireworks_key = getpass("").strip()
    if fireworks_key:
        update_env_var("FIREWORKS_API_KEY", fireworks_key)
    print()
    
    # OpenRouter API Key (optional)
    print("📝 OpenRouter API Key (optional)")
    print("Enter your OpenRouter API key (or press Enter to skip):")
    openrouter_key = getpass("").strip()
    if openrouter_key:
        update_env_var("OPENROUTER_API_KEY", openrouter_key)
    print()
    
    print()
    print("✅ API keys updated in .env")
    print("⚠️  Make sure .env is in .gitignore (it should be already)")
    print()
    print("To verify the keys were added (first few chars only):")
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().split('\n'):
            if '=' in line and any(key in line for key in ['OPENAI', 'FIREWORKS', 'OPENROUTER']):
                key, value = line.split('=', 1)
                masked = value[:8] + "..." if len(value) > 8 else "***"
                print(f"  {key}={masked}")

if __name__ == "__main__":
    main()

