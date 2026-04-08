"""
Notebook preview route for the reviewer app.

POST /api/notebook-preview  — fetch a notebook from a Google Drive / Colab URL
                              and return all labeled sections.

Heading registry: notebook_headings.py
"""
import logging
import sys
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.deps import require_reviewer

_repo_root = str(Path(__file__).resolve().parents[3])
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)
from notebook_headings import TASK_ALIASES, METADATA_KEYS, HIDDEN_FROM_REVIEWER

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["notebook_preview"])


class NotebookPreviewRequest(BaseModel):
    url: str


class SlotResult(BaseModel):
    slot: int
    model_name: str = ""
    model_response: str = ""
    llm_judge: str = ""
    human_judge: str = ""
    reasoning_trace: str = ""


class NotebookPreviewResponse(BaseModel):
    prompt: str
    ideal_response: str
    criteria: list
    slots: list[SlotResult] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)
    extra_cells: list[dict] = Field(default_factory=list)
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

    result = _extract_preview(nb_json)
    return NotebookPreviewResponse(**result)


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


def _extract_bracket_heading(src: str) -> tuple[str | None, str]:
    """Extract [heading] from cell source. Returns (raw_label, body) or (None, src)."""
    import re

    s = src.strip()
    if not s:
        return None, s

    for pattern in (
        r"^\s*\*{1,2}\s*\[([^\]]+)\]\s*\*{1,2}\s*",
        r"^\s*#+\s*\[([^\]]+)\]\s*",
        r"^\s*\[([^\]]+)\]\s*\n",
    ):
        m = re.match(pattern, s, re.IGNORECASE | re.DOTALL)
        if m:
            return m.group(1).strip(), s[m.end():].strip()

    m = re.search(r"\*\*\[([^\]]+)\]\*\*", s, re.IGNORECASE)
    if m:
        return m.group(1).strip(), s[m.end():].strip()
    return None, s


def _classify_heading(label: str) -> tuple[str, str | None, int | None]:
    """
    Classify a raw bracket heading into (category, sub_key, slot_number).

    Returns:
      ("task", "prompt"|"response"|"response_reference", None)
      ("slot_model", model_name, slot_num)
      ("slot_llm_judge", None, slot_num)
      ("slot_human_judge", None, slot_num)
      ("slot_reasoning", None, slot_num)
      ("metadata", normalized_key, None)
      ("extra", None, None)  -- unrecognized
    """
    import re

    raw = label.strip()
    lower = raw.lower()

    # Strip Turn-X: prefix
    stripped = re.sub(r"^turn[_\s-]*\d+\s*[:：]\s*", "", lower, flags=re.IGNORECASE).strip()
    norm = re.sub(r"[\s_-]+", "_", stripped)

    # Task sections (from shared heading registry)
    task_key = TASK_ALIASES.get(norm)
    if task_key:
        return "task", task_key, None

    # Slot: llm_judge_N
    m = re.match(r"^llm_judge[_\s-]*(\d+)$", lower)
    if m:
        return "slot_llm_judge", None, int(m.group(1))

    # Slot: human_judge_N
    m = re.match(r"^human_judge[_\s-]*(\d+)$", lower)
    if m:
        return "slot_human_judge", None, int(m.group(1))

    # Slot: reasoning_trace_N
    m = re.match(r"^reasoning_trace[_\s-]*(\d+)$", lower)
    if m:
        return "slot_reasoning", None, int(m.group(1))

    # Slot: ModelName_N (anything ending with _digits that isn't a known pattern)
    m = re.match(r"^(.+?)[_\s-]+(\d+)$", raw)
    if m:
        name_part = m.group(1).strip()
        slot_num = int(m.group(2))
        name_lower = name_part.lower()
        if name_lower not in ("llm_judge", "human_judge", "reasoning_trace",
                              "selected_response", "selected_judge",
                              "turn", "prompt", "response", "response_reference"):
            return "slot_model", name_part, slot_num

    # Metadata keys (from shared heading registry)
    if norm in METADATA_KEYS:
        return "metadata", norm, None
    m_meta = re.match(r"^turn[_\s-]*\d+[_\s-]*(.+)$", lower)
    if m_meta:
        sub = re.sub(r"[\s_-]+", "_", m_meta.group(1).strip())
        if sub in METADATA_KEYS:
            return "metadata", sub, None

    return "extra", None, None


def _extract_preview(nb_json: dict) -> dict:
    """
    Extract ALL labeled content from a notebook: task sections, hunt slot
    results, metadata, and any extra labeled cells.
    """
    cells = nb_json.get("cells") or []
    warnings: list = []
    cells_scanned = 0

    empty_result = {
        "prompt": "(no prompt)", "ideal_response": "", "criteria": [],
        "slots": [], "metadata": {}, "extra_cells": [],
        "warnings": warnings, "cells_scanned": 0, "has_structured_content": False,
    }

    if not isinstance(nb_json, dict):
        warnings.append("Invalid notebook structure.")
        return empty_result
    if not cells:
        warnings.append("Notebook has no cells, or file is not a valid .ipynb.")
        return empty_result

    prompts: list[str] = []
    ideal_responses: list[str] = []
    response_reference = ""
    slot_data: dict[int, dict] = {}  # slot_num -> {model_name, model_response, llm_judge, ...}
    meta: dict[str, str] = {}
    extra: list[dict] = []

    for cell in cells:
        src = "".join(cell.get("source") or []).strip()
        cells_scanned += 1
        if not src:
            continue

        label, body = _extract_bracket_heading(src)
        if not label:
            continue

        cat, sub, slot_num = _classify_heading(label)

        if cat == "task":
            if sub == "prompt":
                prompts.append(body)
            elif sub == "response":
                ideal_responses.append(body)
            elif sub == "response_reference" and not response_reference:
                response_reference = body

        elif cat.startswith("slot_"):
            sd = slot_data.setdefault(slot_num, {})
            if cat == "slot_model":
                sd["model_name"] = sub
                sd["model_response"] = body
            elif cat == "slot_llm_judge":
                sd["llm_judge"] = body
            elif cat == "slot_human_judge":
                sd["human_judge"] = body
            elif cat == "slot_reasoning":
                sd["reasoning_trace"] = body

        elif cat == "metadata":
            if sub not in HIDDEN_FROM_REVIEWER:
                meta[sub] = body

        elif cat == "extra":
            label_norm = re.sub(r"[\s_-]+", "_", label.strip().lower())
            if label_norm not in HIDDEN_FROM_REVIEWER:
                extra.append({"heading": label, "content": body})

    prompt = "\n\n---\n\n".join(prompts) if prompts else ""
    ideal_response = "\n\n---\n\n".join(ideal_responses) if ideal_responses else ""
    criteria = _parse_criteria(response_reference)

    slots = []
    for sn in sorted(slot_data.keys()):
        sd = slot_data[sn]
        slots.append({
            "slot": sn,
            "model_name": sd.get("model_name", ""),
            "model_response": sd.get("model_response", ""),
            "llm_judge": sd.get("llm_judge", ""),
            "human_judge": sd.get("human_judge", ""),
            "reasoning_trace": sd.get("reasoning_trace", ""),
        })

    has_prompt = bool(prompt and prompt.strip() and prompt != "(no prompt)")
    has_ideal = bool(ideal_response.strip())
    has_crit = bool(criteria)
    has_slots = bool(slots)
    has_structured = has_prompt or has_ideal or has_crit or has_slots

    if not has_structured:
        warnings.append(
            "No labeled task sections found. Start cells with **[prompt]**, **[response]**, or **[response_reference]** "
            "(or markdown # [prompt]), or synonyms like [rubric] / [criteria]."
        )

    return {
        "prompt": prompt or "(no prompt)",
        "ideal_response": ideal_response,
        "criteria": criteria,
        "slots": slots,
        "metadata": meta,
        "extra_cells": extra,
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
