"""
Rule implementations for the agentic reviewer.

Each rule: (snapshot, params) -> Optional[ReviewIssue]
Returns None if passed, ReviewIssue if failed.
"""
from agentic_reviewer.rules.registry import get_registry, register_rule, run_rule

# Import rules to register them
from agentic_reviewer.rules import model_consistency  # noqa: F401
from agentic_reviewer.rules import human_llm_grade_alignment  # noqa: F401
from agentic_reviewer.rules import metadata_prompt_alignment  # noqa: F401
from agentic_reviewer.rules import metadata_taxonomy_alignment  # noqa: F401
from agentic_reviewer.rules import human_explanation_justifies_grade  # noqa: F401
from agentic_reviewer.rules import safety_context_aware  # noqa: F401
from agentic_reviewer.rules import qc_cfa_criteria_valid  # noqa: F401
# New reviewer council rules
from agentic_reviewer.rules import prompt_taxonomy_domain_alignment  # noqa: F401
from agentic_reviewer.rules import user_prompt_length  # noqa: F401
from agentic_reviewer.rules import no_imaginary_constraints  # noqa: F401
from agentic_reviewer.rules import overall_criteria_quality  # noqa: F401
from agentic_reviewer.rules import human_llm_judgment_disagreement  # noqa: F401
from agentic_reviewer.rules import human_explanation_quality  # noqa: F401

__all__ = ["get_registry", "register_rule", "run_rule"]
