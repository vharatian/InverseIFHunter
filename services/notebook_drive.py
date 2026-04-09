"""Google Drive / Colab URL helpers for notebook loading."""
import json
import logging
import os
import re
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


def _extract_drive_file_id(url: str) -> Optional[str]:
    """Extract Google Drive file ID from various URL formats."""
    if "colab.research.google.com/drive/" in url:
        return url.split("/drive/")[-1].split("?")[0].split("#")[0]

    if "drive.google.com/file/d/" in url:
        return url.split("/file/d/")[-1].split("/")[0]

    match = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", url)
    if match:
        return match.group(1)

    return None


def _convert_to_download_url(url: str) -> str:
    """Convert various notebook URLs to direct download URLs."""
    if "colab.research.google.com/drive/" in url:
        file_id = url.split("/drive/")[-1].split("?")[0].split("#")[0]
        return f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}"

    if "drive.google.com/file/d/" in url:
        file_id = url.split("/file/d/")[-1].split("/")[0]
        return f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}"

    if "github.com" in url and "/blob/" in url:
        return url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")

    return url


def _read_with_service_account(file_id: str) -> str:
    """Read notebook content using service account (secure, no public sharing needed)."""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseDownload
        import io

        scopes = ["https://www.googleapis.com/auth/drive.readonly"]

        service_account_paths = [
            "service_account.json",
            "../service_account.json",
            os.path.join(os.path.dirname(__file__), "..", "..", "service_account.json"),
            os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_PATH", ""),
        ]

        service_account_path = None
        for path in service_account_paths:
            if path and os.path.exists(path):
                service_account_path = path
                break

        if not service_account_path:
            tried = ", ".join([p for p in service_account_paths if p])
            raise FileNotFoundError(
                "service_account.json not found. Tried: " + tried
            )

        credentials = service_account.Credentials.from_service_account_file(
            service_account_path, scopes=scopes
        )
        service = build("drive", "v3", credentials=credentials)

        request = service.files().get_media(fileId=file_id)
        buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(buffer, request)

        done = False
        while not done:
            _, done = downloader.next_chunk()

        buffer.seek(0)
        content = buffer.read().decode("utf-8")

        if not (content.strip().startswith("{") and '"cells"' in content):
            raise ValueError("Downloaded content is not a valid notebook")

        return content

    except Exception as e:
        raise Exception(f"Service account read failed: {str(e)}") from e


def _get_service_account_email() -> str:
    """Get service account email for error messages."""
    service_account_paths = [
        "service_account.json",
        "../service_account.json",
        os.path.join(os.path.dirname(__file__), "..", "..", "service_account.json"),
        os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_PATH", ""),
    ]

    for path in service_account_paths:
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    sa_info = json.load(f)
                    return sa_info.get("client_email", "unknown")
            except Exception:
                continue
    return "unknown (service_account.json not found)"


async def load_notebook_content_from_url(url: str) -> str:
    """Fetch raw notebook JSON string from Colab/Drive/direct URL."""
    file_id = _extract_drive_file_id(url)

    content = None

    if file_id:
        try:
            content = _read_with_service_account(file_id)
        except Exception as sa_error:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                download_methods = [
                    f"https://colab.research.google.com/download/ipynb?fileId={file_id}",
                    f"https://drive.google.com/uc?export=download&confirm=1&id={file_id}",
                ]

                for method_url in download_methods:
                    try:
                        response = await client.get(
                            method_url,
                            headers={"User-Agent": "Mozilla/5.0"},
                        )
                        if response.status_code == 200:
                            test_content = response.text
                            if test_content.strip().startswith("{") and '"cells"' in test_content:
                                content = test_content
                                break
                    except Exception:
                        continue

            if not content:
                sa_email = _get_service_account_email()
                raise ValueError(
                    f"Could not access notebook (File ID: {file_id}). "
                    f"Please share the notebook with: {sa_email} (Editor access). "
                    f"Original error: {str(sa_error)}"
                )
    else:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            download_url = _convert_to_download_url(url)
            response = await client.get(download_url)
            response.raise_for_status()
            content = response.text

            if content.strip().startswith("<!") or content.strip().startswith("<html"):
                raise ValueError(
                    "URL returned HTML instead of notebook JSON. "
                    "Please provide a direct link to the .ipynb file."
                )

    return content
