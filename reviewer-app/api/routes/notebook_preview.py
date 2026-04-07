"""
Notebook preview route for the reviewer app.

POST /api/notebook-preview  — fetch a notebook from a Google Drive / Colab URL
                              and return only: prompt, reference (ideal response), criteria.
                              Reviewers use this to verify task content against a link.
"""
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.deps import require_reviewer

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["notebook_preview"])


class NotebookPreviewRequest(BaseModel):
    url: str


class NotebookPreviewResponse(BaseModel):
    prompt: str
    ideal_response: str
    criteria: list
    warnings: list = Field(default_factory=list)
    cells_scanned: int = 0
    has_structured_content: bool = False


@router.post("/notebook-preview", response_model=NotebookPreviewResponse)
async def notebook_preview(
    body: NotebookPreviewRequest,
    _reviewer: Annotated[str, Depends(require_reviewer)],
):
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

    prompt, ideal_response, criteria, meta = _extract_preview(nb_json)
    return NotebookPreviewResponse(
        prompt=prompt,
        ideal_response=ideal_response,
        criteria=criteria,
        warnings=meta.get("warnings") or [],
        cells_scanned=meta.get("cells_scanned") or 0,
        has_structured_content=meta.get("has_structured_content") or False,
    )


def _colab_github_to_raw(url: str) -> str | None:
    """colab.research.google.com/github/owner/repo/blob/branch/path.ipynb -> raw.githubusercontent.com"""
    import re

    if "colab.research.google.com/github/" not in url:
        return None
    m = re.search(
        r"colab\.research\.google\.com/github/([^/]+)/([^/]+)/blob/([^/]+)/(.+?)(?:\?|$)",
        url,
    )
    if not m:
        return None
    owner, repo, branch, path = m.group(1), m.group(2), m.group(3), m.group(4)
    path = path.rstrip("/")
    if not path.endswith(".ipynb"):
        return None
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"


def _drive_file_id_from_url(url: str) -> str | None:
    import re

    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    if "drive.google.com" in url:
        m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", url)
        if m:
            return m.group(1)
    return None


async def _fetch_drive_ipynb_json(client, file_id: str) -> dict:
    """Download .ipynb from Drive; handle virus-scan / large-file HTML interstitial."""
    import json
    import re

    import httpx

    base = f"https://drive.google.com/uc?export=download&id={file_id}"

    async def _try_parse(resp: httpx.Response) -> dict | None:
        if resp.status_code != 200:
            return None
        text = resp.text or ""
        s = text.lstrip()
        if s.startswith("{") and ("nbformat" in text[:4000] or '"cells"' in text[:4000]):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return None
        return None

    resp = await client.get(base)
    data = await _try_parse(resp)
    if data is not None:
        return data

    html = resp.text or ""
    m = re.search(r"confirm=([a-zA-Z0-9_-]+)", html)
    if m:
        url2 = f"https://drive.google.com/uc?export=download&id={file_id}&confirm={m.group(1)}"
        r2 = await client.get(url2)
        data = await _try_parse(r2)
        if data is not None:
            return data

    r3 = await client.get(f"{base}&confirm=t")
    data = await _try_parse(r3)
    if data is not None:
        return data

    if "<html" in html.lower()[:2000]:
        raise ValueError(
            "Google Drive returned a web page instead of the notebook file. "
            'Set the file to "Anyone with the link can view" or open it in Colab and paste the Colab URL.'
        )
    raise ValueError("Could not parse notebook JSON from Google Drive response.")


async def _fetch_notebook_json(url: str) -> dict:
    """Fetch .ipynb JSON from a Google Drive share link, Colab /drive/, Colab/GitHub, or raw URL."""
    import re

    import httpx

    file_id = _drive_file_id_from_url(url)
    download_url = None
    if file_id and ("drive.google.com" in url or "/d/" in url or "id=" in url):
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            return await _fetch_drive_ipynb_json(client, file_id)
    if "colab.research.google.com" in url:
        colab_match = re.search(r"/drive/([a-zA-Z0-9_-]+)", url)
        if colab_match:
            file_id = colab_match.group(1)
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                return await _fetch_drive_ipynb_json(client, file_id)
        gh_raw = _colab_github_to_raw(url)
        if gh_raw:
            download_url = gh_raw
        else:
            download_url = url
    else:
        download_url = url

    async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
        resp = await client.get(download_url)
        if resp.status_code != 200:
            raise ValueError(f"HTTP {resp.status_code} fetching notebook")
        ctype = (resp.headers.get("content-type") or "").lower()
        text_head = (resp.text[:500] if resp.text else "") or ""
        if "text/html" in ctype or text_head.lstrip().lower().startswith("<!doctype") or text_head.lstrip().startswith("<html"):
            raise ValueError(
                "Got an HTML page instead of notebook JSON. "
                "Use a Colab link with /drive/FILE_ID or a shared Drive .ipynb with link access."
            )
        try:
            return resp.json()
        except Exception:
            raise ValueError("Response is not valid JSON. Is the URL a .ipynb file?")


def _normalize_section_label(label: str) -> str | None:
    import re

    n = re.sub(r"[\s_-]+", "_", label.strip().lower())
    if n == "prompt":
        return "prompt"
    if n in ("response", "ideal_response", "ideal", "trainer_response", "expected_response"):
        return "response"
    if n in ("response_reference", "reference", "rubric", "criteria", "scoring", "response_ref", "grading_rubric"):
        return "response_reference"
    return None


def _split_cell_section(src: str) -> tuple[str | None, str]:
    """First line / block heading → (section_key, body). Supports ** [x] **, # [x], or line-start [x]."""
    import re

    s = src.strip()
    if not s:
        return None, s

    m = re.match(r"^\s*\*{1,2}\s*\[([^\]]+)\]\s*\*{1,2}\s*", s, re.IGNORECASE | re.DOTALL)
    if m:
        key = _normalize_section_label(m.group(1))
        if key:
            return key, s[m.end() :].strip()
    m = re.match(r"^\s*#+\s*\[([^\]]+)\]\s*", s, re.IGNORECASE)
    if m:
        key = _normalize_section_label(m.group(1))
        if key:
            return key, s[m.end() :].strip()
    m = re.match(r"^\s*\[([^\]]+)\]\s*\n", s, re.IGNORECASE)
    if m:
        key = _normalize_section_label(m.group(1))
        if key:
            return key, s[m.end() :].strip()

    HEADING = re.compile(r"\*\*\[([^\]]+)\]\*\*", re.IGNORECASE)
    m = HEADING.search(s)
    if m:
        key = _normalize_section_label(m.group(1))
        if key:
            return key, s[m.end() :].strip()
    return None, s


def _extract_preview(nb_json: dict) -> tuple[str, str, list, dict]:
    """
    Extract prompt, ideal_response, and criteria from a raw .ipynb dict.

    Recognizes cells starting with **[prompt]**, # [prompt], **[response]**, **[response_reference]**,
    and common synonyms (rubric, criteria, ideal, …).
    """
    cells = nb_json.get("cells") or []
    warnings: list = []
    cells_scanned = 0
    prompt = ""
    ideal_response = ""
    response_reference = ""

    if not isinstance(nb_json, dict):
        warnings.append("Invalid notebook structure.")
        return "(no prompt)", "", [], {
            "warnings": warnings,
            "cells_scanned": 0,
            "has_structured_content": False,
        }

    if not cells:
        warnings.append("Notebook has no cells, or file is not a valid .ipynb.")
        return "(no prompt)", "", [], {
            "warnings": warnings,
            "cells_scanned": 0,
            "has_structured_content": False,
        }

    for cell in cells:
        src = "".join(cell.get("source") or []).strip()
        cells_scanned += 1
        if not src:
            continue

        key, content = _split_cell_section(src)
        if not key:
            continue

        if key == "prompt" and not prompt:
            prompt = content
        elif key == "response" and not ideal_response:
            ideal_response = content
        elif key == "response_reference" and not response_reference:
            response_reference = content

    criteria = _parse_criteria(response_reference)
    has_prompt = bool(prompt and prompt.strip() and prompt != "(no prompt)")
    has_ideal = bool(ideal_response.strip())
    has_crit = bool(criteria)
    has_structured = has_prompt or has_ideal or has_crit

    if not has_structured:
        warnings.append(
            "No labeled task sections found. Start cells with **[prompt]**, **[response]**, or **[response_reference]** "
            "(or markdown # [prompt]), or synonyms like [rubric] / [criteria]."
        )
    else:
        missing = []
        if not has_prompt:
            missing.append("**[prompt]**")
        if not has_ideal:
            missing.append("**[response]** (ideal answer)")
        if not has_crit:
            missing.append("criteria in **[response_reference]**")
        if missing:
            warnings.append("Missing or empty: " + ", ".join(missing) + ".")

    return prompt or "(no prompt)", ideal_response, criteria, {
        "warnings": warnings,
        "cells_scanned": cells_scanned,
        "has_structured_content": has_structured,
    }


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
