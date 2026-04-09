/**
 * Council state management: shared mutable state, reset, restore from stored data.
 */
import { RULES_REFERENCE } from "./councilRules.js";

let _state = { running: false, rules: {}, ruleOrder: [], abortCtrl: null, chairman: {}, totalRules: 0, rulesDone: 0 };

export function getState() { return _state; }

export function getCouncilState() { return _state; }

export function resetState() {
  if (_state.abortCtrl) _state.abortCtrl.abort();
  _state = { running: false, rules: {}, ruleOrder: [], abortCtrl: null, chairman: {}, totalRules: 0, rulesDone: 0 };
  return _state;
}

export function ruleStateFromStored(rd) {
  const models = {};
  const cr = rd.council_responses || {};
  const votes = rd.council_votes || [];
  for (const v of votes) {
    const mid = v.model_id || v.model;
    if (!mid) continue;
    const text = typeof cr[mid] === "string" ? cr[mid] : "";
    models[mid] = { status: "done", vote: v.vote, chunks: text ? [text] : [] };
  }
  let chairman = null;
  if (rd.chairman_model) {
    chairman = {
      model: rd.chairman_model,
      status: "done",
      passed: rd.chairman_verdict === "PASS",
      rationale: rd.chairman_rationale || "",
      chunks: [],
    };
  }
  const ref = RULES_REFERENCE.find((r) => r.id === rd.rule_id);
  return {
    id: rd.rule_id,
    description: rd.content_checked || ref?.description || rd.rule_id,
    status: "done",
    passed: rd.passed,
    councilVotes: votes,
    chairman,
    issue: rd.issue,
    rationale: rd.rationale,
    models,
  };
}
