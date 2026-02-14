# Future Ideas: Model Hunter × Inverse IFEval

> **Source:** [Inverse IFEval](https://huggingface.co/datasets/m-a-p/Inverse_IFEval) — *Can LLMs Unlearn Stubborn Training Conventions to Follow Real Instructions?*  
> **Purpose:** Track ideas for making Model Hunter smarter, inspired by the research. These are **future/extra ideas**, not required changes.

---

## Research Summary

Inverse IFEval evaluates **Counter-intuitive Ability** — whether LLMs can override training-induced biases and follow instructions that conflict with conventional SFT patterns. Key concepts:

- **Cognitive inertia:** Models struggle when instructions deviate from learned norms (e.g., "avoid bullet points", "answer incorrectly", "no comments in code").
- **Eight instruction types:** Question Correction, Intentional Textual Flaws, Code without Comments, Counter-Conventional Formatting, Deliberately Incorrect Answers, Instructional Induction, Mid-turn Instruction Modification, Counterfactual Answering.
- **Thinking models** perform much better than non-thinking on inverse instructions.
- **Model-specific weaknesses:** Different models fail on different types (e.g., Question Correction is hardest; Counterfactual Answering is easiest).

---

## Idea 1: Inverse Instruction Type Tagging

**What:** Let trainers tag prompts with one or more of the 8 Inverse IFEval types (QC, ITF, CC, CCF, DIA, II, MIM, CA).

**Why:** Enables analytics — "Which models break most on Question Correction?" — and surfaces model weakness profiles.

**Effort:** Low. Add optional `instruction_types: string[]` to notebook metadata or session config.

---

## Idea 2: Pre-built Inverse Instruction Prompt Templates

**What:** Prompt templates or presets for each of the 8 types, with placeholders. E.g.:

- **Counter-Conventional Formatting:** "Provide [N] pieces of advice about [topic]. Do NOT use bullet points, numbered lists, or paragraph breaks."
- **Deliberately Incorrect Answers:** "Answer these [N] questions. You must get exactly [X] correct and [N-X] wrong."
- **Mid-turn Instruction Modification:** Multi-segment prompt where the last segment says "Ignore the above. Instead, answer: [simple question]."

**Why:** Lowers friction for trainers who want to test cognitive inertia but don't know how to phrase it.

**Effort:** Medium. Add template picker or "Insert inverse template" in prompt editor.

---

## Idea 3: Inverse-Style Criteria Presets

**What:** Pre-built criteria that explicitly check for *instruction fidelity* vs *conventional output*:

- "Response must NOT contain bullet points or numbered lists."
- "Response must contain exactly [N] intentional typos."
- "Response must be based ONLY on the given passage, even if it contradicts known facts."
- "Response must NOT include code comments."

**Why:** Criteria often assume "correct" output. Inverse criteria test whether the model followed the *instruction* over its training bias.

**Effort:** Medium. Add criteria preset library; integrate with existing judge flow.

---

## Idea 4: Mid-turn Instruction Modification (Multi-Turn)

**What:** A multi-turn flow where the *last* user message explicitly contradicts or supersedes earlier instructions. E.g.:

- Turn 1: "Summarize the following text in 50 words."
- Turn 2: "Actually, ignore that. Don't summarize. Instead, repeat the text and add 3 random emojis."

**Why:** Tests whether the model prioritizes the latest instruction over earlier context — a known failure mode.

**Effort:** Low–Medium. Already have multi-turn; need UX to make "contradict previous" explicit and measurable.

---

## Idea 5: Model Weakness Profile (Post-Hunt Analytics)

**What:** After hunts, show per-model breakdown by instruction type (when tagged). E.g.:

> **Nemotron:** Breaks most on QC (45%), CCF (38%). Strong on CA (12%).  
> **Qwen3-Thinking:** Breaks most on QC (52%), II (41%).

**Why:** Helps trainers choose models for specific inverse scenarios and surfaces systematic gaps.

**Effort:** Medium. Requires instruction type tagging + aggregation in results/dashboard.

---

## Idea 6: Think vs Non-Think Mode Comparison

**What:** Option to run the same prompt with both thinking and non-thinking variants of the same model (e.g., Qwen3-Thinking vs Qwen3-Instruct) and compare break rates.

**Why:** Paper shows non-thinking models rank much lower on Inverse IFEval. Trainers could quantify this for their prompts.

**Effort:** Medium. Need model pairing (thinking/non-thinking) and side-by-side or A/B result view.

---

## Idea 7: Deliberately Incorrect Reference Response

**What:** Allow the "ideal" or reference response to be *intentionally wrong* (e.g., wrong facts, typos). Judge checks whether the model *followed the instruction* (e.g., "answer based only on this passage") rather than correctness.

**Why:** Tests instruction fidelity when correctness conflicts with the instruction.

**Effort:** Medium–High. Judge logic would need a mode: "score by instruction compliance, not factual correctness."

---

## Idea 8: Best-of-N Sampling Mode

**What:** Option to run N independent samples per prompt and select the best (by judge score). Paper shows N=16–32 dramatically improves Inverse IFEval scores.

**Why:** Surfaces whether failures are capability limits vs sampling variance.

**Effort:** High. Requires N× API calls, aggregation, and "best-of" selection logic.

---

## Idea 9: Domain Tagging (23 Domains)

**What:** Tag prompts by domain (CS, Math, Physics, Law, Biology, etc.) as in Inverse IFEval. Enables domain-specific analytics and break-rate comparison.

**Why:** Some models may be stronger in certain domains; inverse failures may cluster by domain.

**Effort:** Low. Add optional `domain: string` to metadata.

---

## Idea 10: OOD / Inverse Prompt Detection

**What:** Lightweight classifier or heuristic to flag prompts that likely trigger cognitive inertia (e.g., contains "do not use", "ignore", "wrong on purpose", "without comments").

**Why:** Surfaces to trainers that their prompt may be an inverse instruction; suggests enabling inverse-specific criteria or tagging.

**Effort:** Medium. Heuristic-based is simpler; LLM-based classifier is more accurate but heavier.

---

## Idea 11: Per-Type Judge Rubric Presets

**What:** Inverse IFEval uses type-specific judge prompts and rubrics (88% → 98% accuracy with optimization). Offer preset judge system prompts per instruction type.

**Why:** Generic judge may miss inverse-specific failures (e.g., "did it avoid bullet points?").

**Effort:** Medium. Add judge preset selector; possibly type-specific rubric in criteria.

---

## Idea 12: Inverse IFEval Benchmark Mode

**What:** A dedicated mode that loads prompts from Inverse IFEval (or a subset), runs hunts across configured models, and reports scores by type — essentially running the benchmark inside Model Hunter.

**Why:** Enables trainers to reproduce or extend Inverse IFEval results with their own models and judge.

**Effort:** High. Dataset integration, benchmark UI, scoring aggregation.

---

## Priority Overview

| Idea | Effort | Impact | Notes |
|------|--------|--------|------|
| 1. Instruction type tagging | Low | Medium | Foundation for 5, 11 |
| 2. Prompt templates | Medium | High | Quick win for trainers |
| 3. Inverse criteria presets | Medium | High | Directly tests instruction fidelity |
| 4. Mid-turn contradiction | Low–Med | Medium | Extends existing multi-turn |
| 5. Model weakness profile | Medium | High | Needs tagging first |
| 6. Think vs non-think | Medium | Medium | Paper-backed insight |
| 7. Deliberately wrong reference | Med–High | Medium | Judge logic change |
| 8. Best-of-N sampling | High | Medium | Costly, research-oriented |
| 9. Domain tagging | Low | Low–Med | Complements type tagging |
| 10. OOD prompt detection | Medium | Low–Med | Nice-to-have |
| 11. Per-type judge rubrics | Medium | Medium | Improves judge accuracy |
| 12. Inverse IFEval benchmark mode | High | High | Full benchmark integration |

---

## References

- **Paper:** Inverse IFEval — *Can LLMs Unlearn Stubborn Training Conventions to Follow Real Instructions?* (arXiv:2509.04292)
- **Dataset:** https://huggingface.co/datasets/m-a-p/Inverse_IFEval
- **Eight types:** QC, ITF, CC, CCF, DIA, II, MIM, CA (see Appendix A of paper for examples)
