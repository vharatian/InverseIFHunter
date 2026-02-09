"""
E2E shared fixtures: uploaded notebook page, session with results via API.
"""
import pytest
import json
import httpx
from playwright.sync_api import Page

BASE_URL = "http://localhost:8000"


@pytest.fixture
def uploaded_session(page: Page, tmp_path):
    """Upload a notebook via the browser and return (page, session_id).

    After this fixture, the page has a loaded notebook with preview visible.
    Returns (page, session_id) — session_id may be empty if upload mechanism
    differs from expected.
    """
    nb = {
        "nbformat": 4, "nbformat_minor": 5, "metadata": {},
        "cells": [
            {"cell_type": "markdown", "id": "c1", "metadata": {},
             "source": ["**[prompt]**\n\nWhat is 2+2?"]},
            {"cell_type": "markdown", "id": "c2", "metadata": {},
             "source": ["**[response]**\n\nThe answer is 4."]},
            {"cell_type": "markdown", "id": "c3", "metadata": {},
             "source": ['**[response_reference]**\n\n[{"id":"C1","criteria":"Correct answer"}]']},
            {"cell_type": "markdown", "id": "c4", "metadata": {},
             "source": ["**[judge_system_prompt]**\n\nYou are a judge."]},
            {"cell_type": "markdown", "id": "c5", "metadata": {},
             "source": ["**[number_of_attempts_made]**:\n\n0"]},
        ],
    }
    nb_path = tmp_path / "test_e2e.ipynb"
    nb_path.write_text(json.dumps(nb))

    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")

    # Try upload via file chooser
    session_id = ""
    try:
        with page.expect_file_chooser(timeout=5000) as fc_info:
            # Click the upload area — selector may vary
            upload_trigger = page.locator(
                "#uploadSection .upload-area, "
                "[data-upload-trigger], "
                ".upload-btn, "
                "label[for='fileInput'], "
                "#fileInput"
            )
            if upload_trigger.count() > 0:
                upload_trigger.first.click()
        file_chooser = fc_info.value
        file_chooser.set_files(str(nb_path))

        # Wait for preview
        page.wait_for_timeout(3000)

        # Extract session_id from page state
        session_id = page.evaluate(
            "() => window.state?.sessionId || window.sessionId || ''"
        )
    except Exception:
        # Fallback: upload via API and navigate
        with httpx.Client(base_url=BASE_URL) as client:
            nb_json = json.dumps(nb)
            files = {"file": ("test_e2e.ipynb", nb_json, "application/json")}
            r = client.post("/api/upload-notebook", files=files)
            if r.status_code == 200:
                session_id = r.json().get("session_id", "")

    return page, session_id


def inject_results_via_api(session_id: str, results: list) -> bool:
    """Inject mock results into a session via direct storage manipulation."""
    import os
    import glob

    storage_dir = os.path.join(
        os.path.dirname(__file__), "..", "..", ".storage"
    )
    session_file = os.path.join(storage_dir, f"{session_id}.json")

    if not os.path.exists(session_file):
        matches = glob.glob(os.path.join(storage_dir, f"*{session_id}*"))
        if not matches:
            return False
        session_file = matches[0]

    with open(session_file, "r") as f:
        data = json.load(f)

    if "session_data" in data:
        session_data = data["session_data"]
        if isinstance(session_data, str):
            session_data = json.loads(session_data)
        session_data["results"] = results
        session_data["all_results"] = results
        session_data["status"] = "completed"
        session_data["completed_hunts"] = len(results)
        session_data["total_hunts"] = len(results)
        data["session_data"] = session_data
    else:
        data["results"] = results
        data["status"] = "completed"

    with open(session_file, "w") as f:
        json.dump(data, f)

    return True
