"""
Shared Test Utilities

Common utilities for test files to avoid code duplication.
"""
import os
import sys


def load_env(base_path: str = None):
    """
    Load .env file manually.
    
    Args:
        base_path: Base path to look for .env file. 
                   Defaults to the directory of the calling file.
    """
    if base_path is None:
        base_path = os.path.dirname(os.path.abspath(__file__))
    
    env_path = os.path.join(base_path, '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip().strip('"').strip("'")


def setup_path():
    """Add the model-hunter directory to sys.path for imports."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    if base_dir not in sys.path:
        sys.path.insert(0, base_dir)


def get_api_key(key_name: str) -> str:
    """
    Get an API key from environment, loading .env if needed.
    
    Args:
        key_name: Environment variable name (e.g., "FIREWORKS_API_KEY")
    
    Returns:
        The API key value, or empty string if not found
    """
    load_env()
    return os.getenv(key_name, "")
