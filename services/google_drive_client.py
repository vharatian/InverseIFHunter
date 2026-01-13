import re
import io
import json
import logging
from typing import Optional, Dict, Any
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

logger = logging.getLogger(__name__)

class GoogleDriveClient:
    """Client for interacting with Google Drive API to update Colab notebooks."""
    
    SCOPES = ['https://www.googleapis.com/auth/drive']
    SERVICE_ACCOUNT_FILE = 'service_account.json'
    
    def __init__(self, credentials_path: str = 'service_account.json'):
        self.credentials_path = credentials_path
        self.service = None
        self._authenticate()
        
    def _authenticate(self):
        try:
            self.credentials = service_account.Credentials.from_service_account_file(
                self.credentials_path, scopes=self.SCOPES)
            self.service = build('drive', 'v3', credentials=self.credentials)
            logger.info("Successfully authenticated with Google Drive")
        except Exception as e:
            logger.error(f"Failed to authenticate with Google Drive: {e}")
            self.service = None
            
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
            
        try:
            # Create media upload
            media = MediaIoBaseUpload(
                io.BytesIO(content.encode('utf-8')),
                mimetype='application/json',
                resumable=True
            )
            
            # Update file
            self.service.files().update(
                fileId=file_id,
                media_body=media
            ).execute()
            
            logger.info(f"Successfully updated file {file_id}")
            return True
            
        except Exception as e:
            error_str = str(e)
            
            # Parse common Google API errors for user-friendly messages
            if "403" in error_str or "forbidden" in error_str.lower():
                raise Exception(f"Permission denied: The service account doesn't have write access to this notebook. Share the notebook with the service account email (found in service_account.json 'client_email') and give it 'Editor' access.")
            elif "404" in error_str or "not found" in error_str.lower():
                raise Exception(f"File not found: The notebook with ID '{file_id}' doesn't exist or has been deleted.")
            elif "401" in error_str or "unauthorized" in error_str.lower():
                raise Exception("Authentication failed: The service account credentials are invalid or expired. Please check service_account.json.")
            elif "invalid_grant" in error_str.lower():
                raise Exception("Invalid credentials: The service account key may have been revoked. Generate a new key from Google Cloud Console.")
            elif "quota" in error_str.lower():
                raise Exception("API quota exceeded: Too many requests. Please wait a few minutes and try again.")
            else:
                logger.error(f"Error updating file {file_id}: {e}")
                raise Exception(f"Failed to save to Colab notebook: {error_str}")

# Global instance
drive_client = GoogleDriveClient()
