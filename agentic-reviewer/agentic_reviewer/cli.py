"""
CLI runner for local testing.

Usage:
  python -m agentic_reviewer.cli <session.json> preflight --ids 1 2 3 4
  python -m agentic_reviewer.cli <session.json> final
  python -m agentic_reviewer.cli demo preflight   # uses built-in demo
"""
import argparse
import json
import sys
from pathlib import Path

from agentic_reviewer import build_snapshot, run_review

# Demo session (preflight)
_DEMO_SESSION = {
    "session_id": "demo",
    "current_turn": 1,
    "notebook": {
        "prompt": "Write a haiku.",
        "response_reference": '[{"id":"C1","criteria1":"3 lines"},{"id":"C2","criteria2":"Mention code"}]',
    },
    "config": {"models": ["model-a", "model-b"]},
    "all_results": [
        {"hunt_id": i, "model": "qwen/qwen3-235b", "response": f"r{i}"}
        for i in range(1, 5)
    ],
    "human_reviews": {},
}


def _load_session(path: str) -> dict:
    """Load session from JSON file."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Session file not found: {path}")
    with open(p) as f:
        return json.load(f)


def _run(session: dict, checkpoint: str, selected_ids: list[int] | None) -> None:
    """Build snapshot, run review, print result."""
    if checkpoint == "preflight":
        if not selected_ids or len(selected_ids) != 4:
            print("Error: preflight requires --ids with exactly 4 hunt IDs", file=sys.stderr)
            sys.exit(1)
        snapshot = build_snapshot(session, "preflight", selected_hunt_ids=selected_ids)
    else:
        snapshot = build_snapshot(session, "final")

    result = run_review(snapshot)

    out = {
        "passed": result.passed,
        "checkpoint": result.checkpoint,
        "issues": [i.model_dump() for i in result.issues],
        "timestamp": result.timestamp,
    }
    print(json.dumps(out, indent=2))

    if not result.passed:
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Agentic Reviewer CLI")
    parser.add_argument("session", help="Path to session JSON, or 'demo' for built-in")
    parser.add_argument("checkpoint", choices=["preflight", "final"])
    parser.add_argument("--ids", type=int, nargs="+", help="For preflight: 4 hunt IDs")
    args = parser.parse_args()

    if args.session == "demo":
        session = _DEMO_SESSION
        if args.checkpoint == "preflight" and not args.ids:
            args.ids = [1, 2, 3, 4]
    else:
        session = _load_session(args.session)

    _run(session, args.checkpoint, args.ids)


if __name__ == "__main__":
    main()
