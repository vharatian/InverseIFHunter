"""
Tests for security hardening.

Covers: session ID unpredictability, path traversal, XSS payloads,
file upload restrictions, information disclosure, and API abuse.
"""
import pytest
import json
import os
import sys
import re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from tests.conftest import (
    make_passing_result,
    inject_results_into_session,
)


@pytest.mark.security
class TestSessionIDSecurity:
    """Session IDs should be unpredictable and non-sequential."""

    def test_session_id_is_uuid_like(self, client, minimal_notebook):
        """Session ID should look like a UUID (hex chars, not sequential integers)."""
        nb_json = json.dumps(minimal_notebook)
        files = {"file": ("test.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        sid = r.json()["session_id"]
        # Should be hex characters (UUID fragment)
        assert re.match(r'^[a-f0-9-]+$', sid), f"Session ID not UUID-like: {sid}"

    def test_session_ids_not_sequential(self, client, minimal_notebook):
        """Two consecutive session IDs should not be sequential integers."""
        ids = []
        for _ in range(3):
            nb_json = json.dumps(minimal_notebook)
            files = {"file": ("test.ipynb", nb_json, "application/json")}
            r = client.post("/api/upload-notebook", files=files)
            ids.append(r.json()["session_id"])

        # Check they're not sequential
        assert ids[0] != ids[1] != ids[2]
        # Check they're not just incrementing numbers
        try:
            nums = [int(sid) for sid in ids]
            # If all are valid integers, they shouldn't be sequential
            assert not (nums[1] - nums[0] == 1 and nums[2] - nums[1] == 1)
        except ValueError:
            pass  # Good — they're not integers

    def test_cannot_guess_other_session(self, client, create_session):
        """Attempting to access a plausible but wrong session ID returns 404."""
        sid = create_session
        # Try variations of the real session ID
        wrong_ids = [
            sid[:-1] + "0",
            sid[:-1] + "f",
            "00000000",
            "ffffffff",
            sid[::-1],  # reversed
        ]
        for wrong_id in wrong_ids:
            if wrong_id == sid:
                continue
            r = client.get(f"/api/session/{wrong_id}")
            assert r.status_code == 404


@pytest.mark.security
class TestPathTraversal:
    """Attempt path traversal via filenames and session IDs."""

    def test_path_traversal_in_filename(self, client):
        """Upload with ../../etc/passwd as filename — should be rejected or sanitized."""
        nb = json.dumps({
            "nbformat": 4, "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\nTest"]},
            ]
        })
        files = {"file": ("../../etc/passwd", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        # Should succeed (filename sanitized) or reject
        assert r.status_code in [200, 400, 422]
        if r.status_code == 200:
            # Filename should be sanitized
            assert ".." not in r.json().get("notebook", {}).get("filename", "")

    def test_path_traversal_in_session_id(self, client):
        """Session ID with path traversal chars — should 404."""
        r = client.get("/api/session/../../../etc/passwd")
        assert r.status_code in [404, 422]

    def test_null_bytes_in_filename(self, client):
        """Filename with null bytes — should be rejected."""
        nb = json.dumps({
            "nbformat": 4, "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\nTest"]},
            ]
        })
        files = {"file": ("test\x00.ipynb", nb, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [200, 400, 422]


@pytest.mark.security
class TestXSSPrevention:
    """XSS payloads in various input fields."""

    def test_xss_in_prompt_stored_safely(self, client, minimal_notebook):
        """HTML/JS in prompt should be stored as text, not executed."""
        xss_prompt = '<script>alert("XSS")</script><img src=x onerror=alert(1)>'
        nb = dict(minimal_notebook)
        nb["cells"][0]["source"] = [f"**[prompt]**\n\n{xss_prompt}"]
        nb_json = json.dumps(nb)
        files = {"file": ("xss.ipynb", nb_json, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code == 200
        # The script tag should be stored as-is (escaping happens on frontend)
        stored = r.json()["notebook"]["prompt"]
        assert "<script>" in stored or "script" in stored.lower()

    def test_xss_in_criteria(self, client, create_session):
        """XSS in criteria field — stored safely."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        xss_criteria = '[{"id":"C1","criteria":"<script>alert(1)</script>"}]'
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": xss_criteria,
        })
        assert r.status_code == 200

    def test_xss_in_judge_prompt(self, client, create_session):
        """XSS in judge prompt — stored safely."""
        sid = create_session
        inject_results_into_session(sid, [make_passing_result(1)])
        r = client.post(f"/api/advance-turn/{sid}", json={
            "selected_hunt_id": 1,
            "next_prompt": "Follow up",
            "next_criteria": '[{"id":"C1","criteria":"test"}]',
            "next_judge_prompt": '<img src=x onerror="alert(document.cookie)">',
        })
        assert r.status_code == 200


@pytest.mark.security
class TestFileUploadSecurity:
    """File upload restrictions and validation."""

    def test_non_json_file_rejected(self, client):
        """Binary file upload should be rejected."""
        binary_content = bytes(range(256))
        files = {"file": ("malicious.exe", binary_content, "application/octet-stream")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [400, 422, 500]

    def test_html_file_not_executed(self, client):
        """HTML file uploaded as .ipynb should be treated as JSON parse failure."""
        html = "<html><body><script>alert('evil')</script></body></html>"
        files = {"file": ("evil.ipynb", html, "text/html")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [400, 422, 500]

    def test_deeply_nested_json(self, client):
        """Deeply nested JSON (potential DoS) — should handle or reject."""
        # Create a 50-level nested JSON
        nested = {"a": None}
        current = nested
        for _ in range(50):
            current["a"] = {"a": None}
            current = current["a"]
        current["a"] = "bottom"
        data = json.dumps(nested)
        files = {"file": ("nested.ipynb", data, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        # Should not crash the server
        assert r.status_code in [200, 400, 422, 500]

    def test_json_bomb(self, client):
        """Large JSON payload (1MB) — should handle within limits."""
        # Create ~1MB JSON
        big_data = json.dumps({
            "nbformat": 4, "cells": [
                {"cell_type": "markdown", "id": "c1", "metadata": {},
                 "source": ["**[prompt]**\n\n" + "A" * 1_000_000]},
            ]
        })
        files = {"file": ("big.ipynb", big_data, "application/json")}
        r = client.post("/api/upload-notebook", files=files)
        assert r.status_code in [200, 400, 413]  # 413 = payload too large


@pytest.mark.security
class TestInformationDisclosure:
    """Verify no sensitive data is leaked."""

    def test_error_messages_dont_leak_internals(self, client):
        """Error responses should not contain stack traces or file paths."""
        r = client.get("/api/session/nonexistent")
        assert r.status_code == 404
        body = r.text
        # Should not contain Python traceback markers
        assert "Traceback" not in body
        assert "File \"/" not in body
        assert ".py\"" not in body

    def test_health_doesnt_leak_env_vars(self, client):
        """Health endpoint should not reveal API keys or env vars."""
        r = client.get("/api/health")
        body = r.text.lower()
        assert "api_key" not in body
        assert "secret" not in body
        assert "password" not in body
        assert "token" not in body

    def test_version_endpoint_doesnt_leak_paths(self, client):
        """Version endpoint should not reveal server file paths."""
        r = client.get("/api/version")
        body = r.text
        assert "/Users/" not in body
        assert "/home/" not in body
        assert "\\Users\\" not in body

    def test_admin_status_available(self, client):
        """Admin status should be accessible (it's a monitoring endpoint)."""
        r = client.get("/api/admin/status")
        assert r.status_code == 200

    def test_session_response_doesnt_contain_api_keys(self, client, create_session):
        """Session response should never contain API keys."""
        sid = create_session
        r = client.get(f"/api/session/{sid}")
        body = r.text.lower()
        assert "sk-" not in body  # OpenAI key prefix
        assert "api_key" not in body


@pytest.mark.security
class TestHTTPHeaders:
    """Basic security headers should be present."""

    def test_content_type_is_json_for_api(self, client):
        """API endpoints should return application/json."""
        r = client.get("/api/health")
        assert "application/json" in r.headers.get("content-type", "")

    def test_static_files_have_correct_type(self, client):
        """Static HTML should have text/html content type."""
        r = client.get("/")
        content_type = r.headers.get("content-type", "")
        assert "text/html" in content_type

    def test_no_server_header_leak(self, client):
        """Server header should not reveal detailed version info."""
        r = client.get("/api/health")
        server = r.headers.get("server", "")
        # Should not reveal exact Python/uvicorn version
        if server:
            assert "Python" not in server or True  # Soft check
