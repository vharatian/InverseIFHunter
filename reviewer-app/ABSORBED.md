# Reviewer App — Absorbed into Python Core

This directory is no longer a standalone service.
Routes are mounted at `/reviewer/` in the main FastAPI app via `modules/review/router.py`.
Static files are served at `/reviewer/static/`.

Do not run this as a separate app. Use the main `main.py` instead.
