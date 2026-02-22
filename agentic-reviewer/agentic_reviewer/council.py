"""
LLM Council — multi-model consensus for subjective rules.

Runs N enabled models with a pass/fail prompt, aggregates by consensus or chairman.
When consensus is "chairman", a single chairman model synthesizes council votes and reasoning
into the final pass/fail. Used by rules with use_council: true.
"""
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentic_reviewer.llm_client import call_model_sync, call_model_streaming, parse_pass_fail

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "agentic_rules.yaml"

# Truncate council reasoning per model to avoid huge chairman prompt
_CHAIRMAN_COUNCIL_REASONING_MAX = 800


def _get_enabled_models(config: Dict[str, Any]) -> List[str]:
    """Return list of enabled model IDs."""
    models = config.get("models") or []
    out = []
    for m in models:
        if isinstance(m, dict) and m.get("enabled", True):
            mid = m.get("id")
            if mid:
                out.append(str(mid))
        elif isinstance(m, str):
            out.append(m)
    return out


def _build_chairman_prompt(
    original_prompt: str,
    votes_with_reasoning: List[Tuple[str, str, str]],
) -> str:
    """Build prompt for chairman: question + each model's vote and reasoning."""
    prompt_preview = (original_prompt or "")[:3000]
    lines = [
        "You are the chairman. The following question was evaluated by a council of models. Here are their votes and reasoning.",
        "",
        "QUESTION:",
        prompt_preview,
        "",
        "COUNCIL VOTES AND REASONING:",
    ]
    for model_id, vote_str, response_text in votes_with_reasoning:
        reasoning = (response_text or "").strip()
        if len(reasoning) > _CHAIRMAN_COUNCIL_REASONING_MAX:
            reasoning = reasoning[: _CHAIRMAN_COUNCIL_REASONING_MAX] + "..."
        lines.append(f"--- Model: {model_id} ---")
        lines.append(f"Vote: {vote_str}")
        lines.append(f"Reasoning: {reasoning}")
        lines.append("")
    lines.extend([
        "Synthesize the above and decide the final outcome. Output your brief reasoning, then on a new line exactly: PASS or FAIL.",
        "Your final line must be only PASS or FAIL.",
    ])
    return "\n".join(lines)


def run_council(
    prompt: str,
    rule_id: str,
    config_path: Optional[Path] = None,
) -> Tuple[bool, List[Tuple[str, Optional[bool]]]]:
    """
    Run council: N models vote pass/fail, then aggregate by consensus or chairman.

    When consensus is "chairman", a chairman model receives all votes and reasoning
    and returns the final pass/fail. Otherwise uses majority or unanimity.
    """
    from agentic_reviewer.config_loader import get_agentic_council
    path = config_path if config_path and config_path.exists() else None
    council_config = get_agentic_council(path)
    models = _get_enabled_models(council_config)

    if not models:
        logger.warning("Council: no enabled models. Treating as pass.")
        return True, []

    consensus_mode = council_config.get("consensus", "majority")
    chairman_model = council_config.get("chairman_model") or ""
    votes: List[Tuple[str, Optional[bool]]] = []
    responses: List[str] = []

    for model_id in models:
        response, err = call_model_sync(prompt, model_id)
        if err:
            logger.warning("Council model %s error for rule %s: %s", model_id, rule_id, err)
            votes.append((model_id, None))
            responses.append("")
            continue
        vote = parse_pass_fail(response)
        votes.append((model_id, vote))
        responses.append(response or "")
        logger.debug("Council %s (%s): %s -> %s", rule_id, model_id, (response or "")[:80], vote)

    if consensus_mode == "chairman" and chairman_model:
        votes_with_reasoning = [
            (mid, "PASS" if v is True else "FAIL" if v is False else "unclear", resp)
            for (mid, v), resp in zip(votes, responses)
        ]
        chairman_prompt = _build_chairman_prompt(prompt, votes_with_reasoning)
        chairman_response, chairman_err = call_model_sync(
            chairman_prompt, chairman_model, max_tokens=1024
        )
        if chairman_err:
            logger.warning("Council chairman %s error for rule %s: %s", chairman_model, rule_id, chairman_err)
            pass_count = sum(1 for _, v in votes if v is True)
            fail_count = sum(1 for _, v in votes if v is False)
            passed = pass_count > fail_count
        else:
            passed = parse_pass_fail(chairman_response) is True
        logger.info("Council %s: chairman %s -> %s", rule_id, chairman_model, passed)
        return passed, votes

    pass_count = sum(1 for _, v in votes if v is True)
    fail_count = sum(1 for _, v in votes if v is False)
    unclear_count = sum(1 for _, v in votes if v is None)

    if consensus_mode == "unanimity":
        passed = pass_count == len(models) and unclear_count == 0
    else:
        passed = pass_count > fail_count

    logger.info(
        "Council %s: %s (pass=%d fail=%d unclear=%d) -> %s",
        rule_id, consensus_mode, pass_count, fail_count, unclear_count, passed
    )
    return passed, votes


def run_council_streaming(
    prompt: str,
    rule_id: str,
    config_path: Optional[Path] = None,
):
    """
    Run council with streaming: prompt, each model's reasoning (token-by-token), verdict.
    When consensus is "chairman", yields chairman_start, chairman_verdict (with rationale), then complete.
    Yields:
      ("prompt", prompt)
      ("model_start", model_id)
      ("model_chunk", model_id, chunk)
      ("model_verdict", model_id, vote_str, full_response)
      ("chairman_start", chairman_model_id)   # only when consensus=chairman
      ("chairman_verdict", passed, rationale) # only when consensus=chairman
      ("complete", passed, votes)
    """
    from agentic_reviewer.config_loader import get_agentic_council
    path = config_path if config_path and config_path.exists() else None
    council_config = get_agentic_council(path)
    models = _get_enabled_models(council_config)

    if not models:
        logger.warning("Council: no enabled models. Treating as pass.")
        yield ("complete", True, [])
        return

    yield ("prompt", prompt)
    consensus_mode = council_config.get("consensus", "majority")
    chairman_model = (council_config.get("chairman_model") or "").strip()
    votes: List[Tuple[str, Optional[bool]]] = []
    responses: List[str] = []

    for model_id in models:
        yield ("model_start", model_id)
        full_response = []
        had_error = False
        for chunk, err in call_model_streaming(prompt, model_id):
            if err:
                logger.warning("Council model %s error for rule %s: %s", model_id, rule_id, err)
                yield ("model_chunk", model_id, f"[Error: {err}]")
                had_error = True
                break
            if chunk:
                full_response.append(chunk)
                yield ("model_chunk", model_id, chunk)
        response_text = "".join(full_response)
        vote = None if had_error else parse_pass_fail(response_text)
        votes.append((model_id, vote))
        responses.append(response_text)
        vote_str = "PASS" if vote is True else "FAIL" if vote is False else "unclear"
        yield ("model_verdict", model_id, vote_str, response_text)

    if consensus_mode == "chairman" and chairman_model:
        yield ("chairman_start", chairman_model)
        votes_with_reasoning = [
            (mid, "PASS" if v is True else "FAIL" if v is False else "unclear", resp)
            for (mid, v), resp in zip(votes, responses)
        ]
        chairman_prompt = _build_chairman_prompt(prompt, votes_with_reasoning)
        chairman_response, chairman_err = call_model_sync(
            chairman_prompt, chairman_model, max_tokens=1024
        )
        if chairman_err:
            logger.warning("Council chairman %s error for rule %s: %s", chairman_model, rule_id, chairman_err)
            pass_count = sum(1 for _, v in votes if v is True)
            fail_count = sum(1 for _, v in votes if v is False)
            passed = pass_count > fail_count
            rationale = ""
        else:
            passed = parse_pass_fail(chairman_response) is True
            rationale = (chairman_response or "").strip()
        logger.info("Council %s: chairman %s -> %s", rule_id, chairman_model, passed)
        yield ("chairman_verdict", passed, rationale)
        yield ("complete", passed, votes)
        return

    pass_count = sum(1 for _, v in votes if v is True)
    fail_count = sum(1 for _, v in votes if v is False)

    if consensus_mode == "unanimity":
        passed = pass_count == len(models) and all(v is not None for _, v in votes)
    else:
        passed = pass_count > fail_count

    logger.info(
        "Council %s: %s (pass=%d fail=%d) -> %s",
        rule_id, consensus_mode, pass_count, fail_count, passed
    )
    yield ("complete", passed, votes)
