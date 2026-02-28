"""
Notebook preview route for the reviewer app.

POST /api/notebook-preview  — fetch a notebook from a Google Drive / Colab URL
                              and return only: prompt, reference (ideal response), criteria.
                              Reviewers use this to verify task content against a link.
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["notebook_preview"])


class NotebookPreviewRequest(BaseModel):
    url: str


class NotebookPreviewResponse(BaseModel):
    prompt: str
    ideal_response: str
    criteria: list


@router.post("/notebook-preview", response_model=NotebookPreviewResponse)
async def notebook_preview(body: NotebookPreviewRequest):
    """
    Fetch a notebook from Google Drive/Colab URL and return prompt + ideal response.
    No session is created; this is read-only for the reviewer.
    """
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")

    try:
        nb_json = await _fetch_notebook_json(url)
    except Exception as e:
        logger.warning("Notebook fetch failed for %s: %s", url, e)
        raise HTTPException(status_code=400, detail=f"Could not fetch notebook: {e}")

    prompt, ideal_response, criteria = _extract_preview(nb_json)
    return NotebookPreviewResponse(prompt=prompt, ideal_response=ideal_response, criteria=criteria)


async def _fetch_notebook_json(url: str) -> dict:
    """Fetch .ipynb JSON from a Google Drive share link or direct URL."""
    import re
    import json

    # Convert Google Drive share link to direct download
    drive_match = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if drive_match:
        file_id = drive_match.group(1)
        download_url = f"https://drive.google.com/uc?export=download&id={file_id}"
    elif "colab.research.google.com" in url:
        # Colab URL: extract file id from /drive/ path
        colab_match = re.search(r"/drive/([a-zA-Z0-9_-]+)", url)
        if colab_match:
            file_id = colab_match.group(1)
            download_url = f"https://drive.google.com/uc?export=download&id={file_id}"
        else:
            download_url = url
    else:
        download_url = url

    import httpx
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(download_url)
        if resp.status_code != 200:
            raise ValueError(f"HTTP {resp.status_code} fetching notebook")
        try:
            return resp.json()
        except Exception:
            raise ValueError("Response is not valid JSON. Is the URL a .ipynb file?")


def _extract_preview(nb_json: dict) -> tuple[str, str, list]:
    """
    Extract prompt, ideal_response, and criteria from a raw .ipynb dict.

    - prompt        ← **[prompt]** cell
    - ideal_response ← **[response]** cell (trainer-written expected answer)
    - criteria      ← parsed from **[response_reference]** cell (rubric/scoring criteria)
    """
    import re

    HEADING = re.compile(r'\*\*\[([^\]]+)\]\*\*', re.IGNORECASE)

    cells = nb_json.get("cells") or []
    prompt = ""
    ideal_response = ""
    response_reference = ""

    for cell in cells:
        src = "".join(cell.get("source") or []).strip()
        if not src:
            continue

        m = HEADING.search(src)
        if not m:
            continue

        heading = m.group(1).strip().lower()
        # Content is everything after the heading marker
        content = src[m.end():].strip()

        if heading == "prompt" and not prompt:
            prompt = content
        elif heading == "response" and not ideal_response:
            ideal_response = content
        elif heading == "response_reference" and not response_reference:
            response_reference = content

    criteria = _parse_criteria(response_reference)
    return prompt or "(no prompt)", ideal_response, criteria


def _parse_criteria(reference: str) -> list:
    """Parse criteria from reference text."""
    import re
    import json

    if not reference:
        return []

    array_match = re.search(r"\[.*?\]", reference, re.DOTALL)
    if array_match:
        try:
            parsed = json.loads(array_match.group(0))
            if isinstance(parsed, list):
                out = []
                for i, item in enumerate(parsed):
                    if isinstance(item, dict):
                        cid = item.get("id", f"C{i+1}")
                        desc = next((str(v) for k, v in item.items() if k.startswith("criteria") and k != "id"), None)
                        if desc:
                            out.append({"id": str(cid).upper(), "description": desc})
                return out
        except json.JSONDecodeError:
            pass

    pattern = re.compile(r"^(C\d+)\s*[:：]\s*(.+)$", re.MULTILINE | re.IGNORECASE)
    return [{"id": m.group(1).upper(), "description": m.group(2).strip()} for m in pattern.finditer(reference)]
