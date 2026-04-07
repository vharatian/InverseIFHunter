"""
Import InverseIFHunter ``services.pg_session`` without colliding with reviewer-app ``services``.
Inserts repo root at the front of sys.path for the duration of import.
"""
import importlib
import sys
from pathlib import Path

_IH_ROOT = Path(__file__).resolve().parents[2]


def _pg_session():
    root = str(_IH_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    return importlib.import_module("services.pg_session")


async def get_last_reviewer_council(session_id: str):
    pg = _pg_session()
    return await pg.get_last_qc_run_pg(session_id, "reviewer_council")


async def insert_reviewer_council_run(
    session_id: str,
    result: dict,
    rules_applied: list,
):
    pg = _pg_session()
    await pg.insert_qc_run_pg(
        session_id=session_id,
        run_type="reviewer_council",
        result=result,
        rules_applied=rules_applied,
    )
