"""
Rule Engine — load rules from config, run each, aggregate results.

Does not import from model-hunter. Accepts TaskSnapshot, returns ReviewResult.
Loads from global config (config/global.yaml) when config_path is None.
"""
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentic_reviewer.schemas import (
    Checkpoint,
    ReviewIssue,
    ReviewResult,
    TaskSnapshot,
)
import agentic_reviewer.rules  # noqa: F401 — triggers rule registration
from agentic_reviewer.rules.registry import run_rule

logger = logging.getLogger(__name__)

# Fallback config path (when global config has no agentic.rules)
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "agentic_rules.yaml"


def _filter_rules_for_checkpoint(
    rules: List[Dict[str, Any]], checkpoint: Checkpoint
) -> List[Dict[str, Any]]:
    """Keep only enabled rules that apply to this checkpoint."""
    out = []
    for r in rules:
        if not isinstance(r, dict):
            continue
        if not r.get("enabled", True):
            continue
        checkpoints = r.get("checkpoints") or ["preflight", "final"]
        if checkpoint not in checkpoints:
            continue
        out.append(r)
    return out


def get_rules_for_checkpoint(
    checkpoint: Checkpoint,
    config_path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Return list of rule definitions for the given checkpoint."""
    from agentic_reviewer.config_loader import get_agentic_rules
    path = config_path if config_path and config_path.exists() else None
    all_rules = get_agentic_rules(path)
    return _filter_rules_for_checkpoint(all_rules, checkpoint)


def run_review(
    snapshot: TaskSnapshot,
    config_path: Optional[Path] = None,
) -> ReviewResult:
    """
    Run all applicable rules against the snapshot. Aggregate into ReviewResult.

    Args:
        snapshot: TaskSnapshot from snapshot_builder.
        config_path: Path to YAML config. Default: global config, fallback agentic_rules.yaml.

    Returns:
        ReviewResult with passed=True if no issues, else passed=False and issues list.
    """
    from agentic_reviewer.config_loader import get_agentic_rules
    path = config_path if config_path and config_path.exists() else None
    all_rules = get_agentic_rules(path)
    rules = _filter_rules_for_checkpoint(all_rules, snapshot.checkpoint)

    issues: List[ReviewIssue] = []
    for rule_def in rules:
        rule_id = rule_def.get("id")
        if not rule_id:
            continue
        params = rule_def.get("params") or {}
        try:
            issue = run_rule(rule_id, snapshot, params)
            if issue:
                issues.append(issue)
        except KeyError as e:
            logger.warning("Rule %s not registered: %s", rule_id, e)
        except Exception as e:
            logger.exception("Rule %s failed", rule_id)
            issues.append(
                ReviewIssue(
                    rule_id=rule_id,
                    message=f"Rule error: {e}",
                    hint="Check logs.",
                )
            )

    passed = len(issues) == 0
    return ReviewResult(
        passed=passed,
        issues=issues,
        checkpoint=snapshot.checkpoint,
    )


def run_review_streaming(
    snapshot: TaskSnapshot,
    config_path: Optional[Path] = None,
):
    """
    Run rules one by one, yielding (rule_def, issue) for each.
    Enables live streaming of rule results to the UI.
    """
    from agentic_reviewer.config_loader import get_agentic_rules
    path = config_path if config_path and config_path.exists() else None
    all_rules = get_agentic_rules(path)
    rules = _filter_rules_for_checkpoint(all_rules, snapshot.checkpoint)

    issues: List[ReviewIssue] = []
    for rule_def in rules:
        rule_id = rule_def.get("id")
        if not rule_id:
            continue
        params = rule_def.get("params") or {}
        issue = None
        try:
            issue = run_rule(rule_id, snapshot, params)
            if issue:
                issues.append(issue)
        except KeyError as e:
            logger.warning("Rule %s not registered: %s", rule_id, e)
        except Exception as e:
            logger.exception("Rule %s failed", rule_id)
            issue = ReviewIssue(
                rule_id=rule_id,
                message=f"Rule error: {e}",
                hint="Check logs.",
            )
            issues.append(issue)

        yield rule_def, issue
