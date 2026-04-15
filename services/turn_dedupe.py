"""Deduplicate session.turns by turn_number (last entry wins)."""
from __future__ import annotations

from typing import Any, List, Optional

from models.schemas import TurnData


def dedupe_turns_to_models(turns: Optional[List[Any]]) -> List[TurnData]:
    """Return sorted unique turns; same turn_number keeps the last occurrence in the input list."""
    by_num: dict[int, TurnData] = {}
    for item in turns or []:
        td: Optional[TurnData] = None
        if isinstance(item, TurnData):
            td = item
        elif isinstance(item, dict):
            try:
                td = TurnData.model_validate(item)
            except Exception:
                continue
        elif isinstance(item, str):
            try:
                td = TurnData.model_validate_json(item)
            except Exception:
                continue
        if td is None:
            continue
        n = int(td.turn_number)
        if n < 1:
            continue
        by_num[n] = td
    return [by_num[k] for k in sorted(by_num.keys())]
