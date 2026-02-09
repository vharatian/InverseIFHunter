"""
E2E: Test responsive layout and theme switching.
"""
import pytest
from playwright.sync_api import Page, expect

BASE_URL = "http://localhost:8000"


@pytest.mark.e2e
class TestResponsiveAndTheme:

    def test_desktop_viewport(self, page: Page):
        """Page should render correctly at desktop resolution."""
        page.set_viewport_size({"width": 1920, "height": 1080})
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        body = page.text_content("body")
        assert body is not None and len(body) > 0

    def test_mobile_viewport(self, page: Page):
        """Page should render correctly at mobile resolution."""
        page.set_viewport_size({"width": 375, "height": 812})
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        body = page.text_content("body")
        assert body is not None and len(body) > 0

    def test_theme_toggle_switches(self, page: Page):
        """Theme toggle should switch between light and dark."""
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        toggle = page.locator("#themeToggle")
        if toggle.count() == 0:
            pytest.skip("Theme toggle not found")

        html = page.locator("html")
        initial = html.get_attribute("data-theme")
        toggle.click()
        page.wait_for_timeout(300)
        after_first = html.get_attribute("data-theme")
        assert initial != after_first

        # Toggle back
        toggle.click()
        page.wait_for_timeout(300)
        after_second = html.get_attribute("data-theme")
        assert after_second == initial

    def test_tablet_viewport(self, page: Page):
        """Page should render correctly at tablet resolution."""
        page.set_viewport_size({"width": 768, "height": 1024})
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        body = page.text_content("body")
        assert body is not None and len(body) > 0
