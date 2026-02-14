import pytest
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

@pytest.mark.security
class TestColabLinkModification:
    """Tests to ensure that Colab links cannot be maliciously modified."""

    def test_colab_link_modification(self, client, create_session):
        """Attempt to modify the Colab link and ensure it's handled safely."""
        session_id = create_session
        malicious_link = "https://colab.research.google.com/drive/1FAKEID?usp=sharing"

        # Attempt to update the session with a malicious Colab link
        response = client.post(f"/api/session/{session_id}/update-colab-link", json={
            "colab_link": malicious_link
        })

        # Ensure the server rejects the modification or sanitizes the link
        assert response.status_code in [400, 422], "Server should reject or sanitize malicious Colab link"

        # Retrieve session details to verify the Colab link wasn't updated
        session_details = client.get(f"/api/session/{session_id}")
        assert session_details.status_code == 200
        assert session_details.json().get("colab_link") != malicious_link, "Colab link should not be updated with malicious input"