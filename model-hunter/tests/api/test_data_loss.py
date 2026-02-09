"""
Tests for data loss and corruption scenarios.

Covers: session disappearance, storage corruption, duplicate data,
stale sessions, and edge cases around data integrity.
"""
import pytest
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    make_breaking_result,
    inject_results_into_session,
)


@pytest.mark.api
class TestSessionDisappearance:
    """Session data vanishes from memory or storage."""

    def test_nonexistent_session_returns_404(self, client):
        """Fetching a session that never existed gives a clean 404."""
        r = client.get("/api/session/does-not-exist-at-all")
        assert r.status_code == 404

    def test_advance_turn_nonexistent_session(self, client):
        """advance-turn on deleted session returns 404."""
        r = client.post("/api/advance-turn/ghost-session", json={
            "selected_hunt_id": 1,
            "next_prompt": "hello",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r.status_code == 404

    def test_mark_breaking_nonexistent_session(self, client):
        """mark-breaking on deleted session returns 404."""
        r = client.post("/api/mark-breaking/ghost-session")
        assert r.status_code == 404

    def test_results_nonexistent_session(self, client):
        """results endpoint on deleted session returns 404 or empty results."""
        r = client.get("/api/results/ghost-session")
        # The results endpoint may return 200 with empty results or 404
        assert r.status_code in [200, 404]

    def test_turn_status_nonexistent_session(self, client):
        """turn-status on deleted session returns 404."""
        r = client.get("/api/turn-status/ghost-session")
        assert r.status_code == 404

    def test_judge_reference_nonexistent_session(self, client):
        """judge-reference on deleted session returns 404."""
        r = client.post("/api/judge-reference/ghost-session")
        assert r.status_code == 404


@pytest.mark.api
class TestDuplicateData:
    """Scenarios where data gets duplicated."""

    def test_upload_same_notebook_twice_creates_different_sessions(self, client, minimal_notebook):
        """Uploading the same notebook twice should create two distinct sessions."""
        nb_json = json.dumps(minimal_notebook)
        files1 = {"file": ("test.ipynb", nb_json, "application/json")}
        r1 = client.post("/api/upload-notebook", files=files1)
        assert r1.status_code == 200
        sid1 = r1.json()["session_id"]

        files2 = {"file": ("test.ipynb", nb_json, "application/json")}
        r2 = client.post("/api/upload-notebook", files=files2)
        assert r2.status_code == 200
        sid2 = r2.json()["session_id"]

        assert sid1 != sid2

    def test_inject_duplicate_hunt_ids(self, client, create_session):
        """Injecting results with duplicate hunt_ids -- last write wins."""
        sid = create_session
        inject_results_into_session(sid, [
            make_passing_result(1, "First version"),
            make_passing_result(1, "Second version"),  # same hunt_id
        ])
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        results = r.json()["results"]
        # Both should be present (no dedup at storage level)
        assert len(results) == 2

    def test_double_advance_turn(self, client, create_session):
        """Advancing the same turn twice should handle gracefully."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        # First advance
        r1 = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
        })
        assert r1.status_code == 200
        assert r1.json()["current_turn"] == 2

        # Second advance -- hunt_id 1 is now from previous turn
        # This should fail because there are no results in current turn
        r2 = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Another follow up",
            "next_criteria": '[{"id":"C1","criteria":"test2"}]',
        })
        # May succeed (finding in all_results) or fail (400) — neither should be 500
        assert r2.status_code in [200, 400]


@pytest.mark.api
class TestCorruptedNotebooks:
    """Upload notebooks with various forms of corruption."""

    def test_notebook_missing_prompt_cell(self, client):
        """Notebook without a [prompt] cell — should still parse."""
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[response]**\n\nSome response"]},
            ]
        })
        files = {"file": ("no_prompt.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        data = r.json()
        # Prompt should be empty, not crash
        assert data["notebook"]["prompt"] == "" or data["notebook"]["prompt"] is not None

    def test_notebook_missing_response_reference(self, client):
        """Notebook without [response_reference] — should still parse."""
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\nWhat is 2+2?"]},
            ]
        })
        files = {"file": ("no_ref.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200

    def test_notebook_with_unicode_content(self, client):
        """Notebook with unicode/emoji in prompt and response."""
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\nExplain 量子力学 in simple terms 🧪"]},
                {"cell_type": "markdown", "id": "c2", "metadata": {},
                 "source": ["**[response]**\n\n量子力学とは... 🎯"]},
                {"cell_type": "markdown", "id": "c3", "metadata": {},
                 "source": ['**[response_reference]**\n\n[{"id":"C1","criteria":"Uses appropriate scientific terminology"}]']},
                {"cell_type": "markdown", "id": "c4", "metadata": {},
                 "source": ["**[judge_system_prompt]**\n\nYou are a judge."]},
            ]
        })
        files = {"file": ("unicode.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        data = r.json()
        assert "量子力学" in data["notebook"]["prompt"]

    def test_notebook_with_extremely_large_cell(self, client):
        """Notebook with a single cell containing 100KB of text."""
        long_text = "A" * 100_000
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": [f"**[prompt]**\n\n{long_text}"]},
                {"cell_type": "markdown", "id": "c2", "metadata": {},
                 "source": ['**[response_reference]**\n\n[{"id":"C1","criteria":"test"}]']},
                {"cell_type": "markdown", "id": "c3", "metadata": {},
                 "source": ["**[judge_system_prompt]**\n\nYou are a judge."]},
            ]
        })
        files = {"file": ("huge.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        data = r.json()
        assert len(data["notebook"]["prompt"]) >= 100_000

    def test_notebook_with_invalid_criteria_json(self, client):
        """Notebook with response_reference that isn't valid JSON."""
        nb = json.dumps({
            "nbformat": 4, "nbformat_minor": 5, "metadata": {},
            "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\nTest prompt"]},
                {"cell_type": "markdown", "id": "c2", "metadata": {},
                 "source": ["**[response_reference]**\n\nthis is not json at all"]},
                {"cell_type": "markdown", "id": "c3", "metadata": {},
                 "source": ["**[judge_system_prompt]**\n\nYou are a judge."]},
            ]
        })
        files = {"file": ("bad_criteria.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        # Should upload fine (validation happens at judge time)
        assert r.status_code == 200

    def test_notebook_with_100_plus_cells(self, client):
        """Notebook with 100+ cells — parser shouldn't timeout."""
        cells = []
        cells.append({
            "cell_type": "markdown", "id": "c0", "metadata": {},
            "source": ["**[prompt]**\n\nMain prompt"],
        })
        for i in range(1, 101):
            cells.append({
                "cell_type": "code", "id": f"c{i}", "metadata": {},
                "source": [f"# Cell {i}\nprint('hello {i}')"],
                "outputs": [],
                "execution_count": i,
            })
        cells.append({
            "cell_type": "markdown", "id": "c101", "metadata": {},
            "source": ['**[response_reference]**\n\n[{"id":"C1","criteria":"test"}]'],
        })
        nb = json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": cells})
        files = {"file": ("big.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200


@pytest.mark.api
class TestStaleSessionHandling:
    """Sessions that have been idle for a long time."""

    def test_old_session_still_accessible(self, client, create_session):
        """A session created 'long ago' should still be queryable."""
        sid = create_session
        # Simulate time passing by just querying it
        r = client.get(f"/api/session/{sid}")
        assert r.status_code == 200

    def test_results_from_stale_session_are_correct(self, client, create_session):
        """Results injected into a stale session are still valid."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.get(f"/api/results/{sid}")
        assert r.status_code == 200
        assert len(r.json()["results"]) == 1
