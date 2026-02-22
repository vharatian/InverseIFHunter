import re
import io
import json
import os
import logging
from typing import Optional, Dict, Any
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

from agentic_reviewer.resilience import retry_sync

logger = logging.getLogger(__name__)


class _TransientDriveError(Exception):
    """Wraps a Google API error that is safe to retry (quota, 5xx, network)."""
    pass

class GoogleDriveClient:
    """Client for interacting with Google Drive API to update Colab notebooks."""
    
    SCOPES = ['https://www.googleapis.com/auth/drive']
    SERVICE_ACCOUNT_FILE = 'service_account.json'
    
    def __init__(self, credentials_path: str = None):
        # Auto-detect service account path if not provided
        if credentials_path is None:
            credentials_path = self._find_service_account_file()
        self.credentials_path = credentials_path
        self.service = None
        self._authenticate()
    
    def _find_service_account_file(self) -> str:
        """Find service_account.json in common locations."""
        import os
        service_account_paths = [
            'service_account.json',  # Current directory
            '../service_account.json',  # Parent directory (for VM)
            os.path.join(os.path.dirname(__file__), '..', '..', 'service_account.json'),  # Relative to this file
        ]
        
        # Check environment variable
        env_path = os.getenv('GOOGLE_SERVICE_ACCOUNT_JSON_PATH', '')
        if env_path:
            service_account_paths.insert(0, env_path)
        
        for path in service_account_paths:
            if path and os.path.exists(path):
                logger.info(f"Found service_account.json at: {os.path.abspath(path)}")
                return path
        
        # Default fallback
        default_path = 'service_account.json'
        logger.warning(f"service_account.json not found in common locations, using default: {default_path}")
        return default_path
        
    def _authenticate(self):
        try:
            if not os.path.exists(self.credentials_path):
                raise FileNotFoundError(
                    f"Service account file not found: {self.credentials_path}\n"
                    f"Please ensure service_account.json exists in one of these locations:\n"
                    f"- Current directory: {os.getcwd()}/service_account.json\n"
                    f"- Parent directory: {os.path.join(os.getcwd(), '..', 'service_account.json')}\n"
                    f"- Or set GOOGLE_SERVICE_ACCOUNT_JSON_PATH environment variable"
                )
            self.credentials = service_account.Credentials.from_service_account_file(
                self.credentials_path, scopes=self.SCOPES)
            self.service = build('drive', 'v3', credentials=self.credentials)
            logger.info(f"Successfully authenticated with Google Drive using {self.credentials_path}")
        except Exception as e:
            logger.error(f"Failed to authenticate with Google Drive: {e}")
            self.service = None
            
    @staticmethod
    def _raise_user_friendly(error_str: str, file_id: str, sa_email: str):
        """Raise a descriptive exception based on the Google API error."""
        if "403" in error_str or "forbidden" in error_str.lower():
            raise Exception(
                f"Permission denied: The service account doesn't have write access to this notebook.\n\n"
                f"To fix this:\n"
                f"1. Open the notebook in Google Colab/Drive\n"
                f"2. Click 'Share' button\n"
                f"3. Add this email: {sa_email}\n"
                f"4. Give it 'Editor' access\n"
                f"5. Try saving again"
            )
        if "404" in error_str or "not found" in error_str.lower():
            raise Exception(
                f"File not found: The notebook with ID '{file_id}' doesn't exist or the service account cannot access it.\n\n"
                f"To fix this:\n"
                f"1. Make sure the notebook still exists in Google Drive/Colab\n"
                f"2. Open the notebook and click 'Share'\n"
                f"3. Add this email: {sa_email}\n"
                f"4. Give it 'Editor' access\n"
                f"5. Reload the notebook in Model Hunter and try again"
            )
        if "401" in error_str or "unauthorized" in error_str.lower():
            raise Exception("Authentication failed: The service account credentials are invalid or expired. Please check service_account.json.")
        if "invalid_grant" in error_str.lower():
            raise Exception("Invalid credentials: The service account key may have been revoked. Generate a new key from Google Cloud Console.")
        raise Exception(f"Failed to save to Colab notebook: {error_str}")

    def get_file_id_from_url(self, url: str) -> Optional[str]:
        """Extract file ID from Colab/Drive URL."""
        # Match /drive/ID or id=ID
        patterns = [
            r'/drive/([^/?#&]+)',
            r'id=([^/?#&]+)',
            r'/file/d/([^/?#&]+)',
            r'/open\?id=([^/?#&]+)'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        return None
        
    def update_file_content(self, file_id: str, content: str) -> bool:
        """Update file content on Google Drive."""
        if not self.service:
            raise Exception("Google Drive not configured. Please check service_account.json exists and is valid.")
        
        # Get service account email for error messages
        service_account_email = ""
        try:
            import json
            with open(self.credentials_path, 'r') as f:
                sa_info = json.load(f)
                service_account_email = sa_info.get('client_email', 'unknown')
        except:
            pass
        
        try:
            self.service.files().get(
                fileId=file_id,
                fields='id,name',
                supportsAllDrives=True,
            ).execute()
            logger.info(f"Verified access to file {file_id}")
        except Exception as e:
            self._raise_user_friendly(str(e), file_id, service_account_email)
            
        def _do_upload():
            media = MediaIoBaseUpload(
                io.BytesIO(content.encode('utf-8')),
                mimetype='application/json',
                resumable=True
            )
            try:
                self.service.files().update(
                    fileId=file_id,
                    media_body=media,
                    supportsAllDrives=True,
                ).execute()
            except Exception as e:
                error_str = str(e)
                if "quota" in error_str.lower() or "500" in error_str or "503" in error_str:
                    raise _TransientDriveError(error_str) from e
                self._raise_user_friendly(error_str, file_id, service_account_email)

        try:
            retry_sync(
                _do_upload,
                retryable=(_TransientDriveError,),
                context=f"Google Drive upload {file_id}",
            )
            logger.info(f"Successfully updated file {file_id}")
            return True
        except _TransientDriveError as e:
            raise Exception(f"Google Drive upload failed after retries: {e}") from e

# Global instance
drive_client = GoogleDriveClient()
