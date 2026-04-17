import { elements } from '../dom.js';
import { state } from '../state.js';
import { getHuntModeById } from '../config.js';
import { getModelDisplayName } from '../utils.js';
import { showToast, showError, triggerColabConfetti } from '../celebrations.js?v=43';
import { playFinalSubmission, playFinalSubmissionError } from '../sounds.js?v=43';
import { progressiveSaveToColab } from './drive-save.js';
function _makeCell(heading, content, cellId) {
    return {
        cell_type: 'markdown',
        id: cellId || `cell_${heading.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`,
        metadata: {},
        source: [`**[${heading}]**\n\n${content}`]
    };
}

/**
 * Format helpers for the four per-slot cells.
 */
function _slotModelResponse(result) {
    return result.response || '(no response)';
}

function _slotLlmJudge(result) {
    const lines = [];
    const llmScore = result.judge_score !== undefined && result.judge_score !== null
        ? result.judge_score : '(n/a)';
    const llmCriteria = result.judge_criteria || {};

    if (Object.keys(llmCriteria).length > 0) {
        // Sort criteria keys naturally (C1, C2, ... C10) before serialising
        const sortedCriteria = Object.fromEntries(
            Object.entries(llmCriteria).sort(([a], [b]) =>
                a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
            )
        );
        lines.push(`**Criteria Grades:**\n\`\`\`json\n${JSON.stringify(sortedCriteria, null, 2)}\n\`\`\``);
    }

    lines.push(`\n**Score:** ${llmScore}`);

    // Ensure each criterion line gets its own paragraph in Colab markdown
    // (single \n isn't enough — Colab needs \n\n for visible line breaks)
    const rawExplanation = result.judge_explanation || '(no explanation)';
    const formattedExplanation = rawExplanation
        .replace(/\n(\[FAIL\]|\[PASS\]|\[MISSING\])/g, '\n\n$1');

    lines.push(`\n**Explanation:**\n${formattedExplanation}`);
    return lines.join('\n');
}

function _slotHumanJudge(review) {
    if (!review) return '(no human review)';
    const lines = [];
    const grading = review.grading_basis || {};
    const gradingJson = JSON.stringify(
        Object.fromEntries(Object.entries(grading).map(([k, v]) => [k, String(v).toUpperCase()])),
        null, 2
    );
    const total = Object.keys(grading).length;
    const passCount = Object.values(grading).filter(v => String(v).toUpperCase() === 'PASS').length;
    const score = total > 0 && passCount > total / 2 ? 1 : 0;
    lines.push(`**Grading Basis:**\n\`\`\`json\n${gradingJson}\n\`\`\``);
    lines.push(`\n**Score:** ${score} point(s) — \`{"answer_score": ${score}}\``);
    lines.push(`\n**Explanation:**\n${review.explanation || '(no explanation)'}`);
    return lines.join('\n');
}

function _slotReasoningTrace(result) {
    return result.reasoning_trace || '(no reasoning trace)';
}

/**
 * Sanitise a model name/id for use as a cell label prefix.
 * e.g. "anthropic/claude-opus-4-6" → "ClaudeOpus46"
 *      "gpt-5.2"                    → "GPT5.2"
 */
function _modelCellName(modelId) {
    const display = getModelDisplayName(modelId);
    // Remove spaces, keep dots so "GPT 5.2" → "GPT5.2", "Claude Opus 4 6" → "ClaudeOpus46"
    return display.replace(/\s+/g, '');
}
export async function submitToColab() {
    const btn = elements.submitColabBtn;
    if (!btn) return;

    if (!state.llmRevealed) {
        showToast('Reveal AI Evaluation first before submitting to Colab.', 'error');
        return;
    }

    const notebookUrl = state.notebook?.url || document.getElementById('colabUrlInput')?.value || '';
    if (!notebookUrl) {
        showToast('No Colab URL found. Please fetch notebook from URL first.', 'error');
        return;
    }

    const selectedRowNumbers = state.selectedRowNumbers || [];
    if (selectedRowNumbers.length === 0) {
        showToast('No responses selected. Please select and confirm responses first.', 'error');
        return;
    }

    const selectedResults = selectedRowNumbers.map(rn => state.allResponses[rn]).filter(r => r);
    if (selectedResults.length === 0) {
        showToast('Could not resolve selected responses.', 'error');
        return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const cells = [];

        const validResponseCount = state.allResponses.filter(r => r.response && r.response.trim() && !r.error).length;
        const totalAttempts = state.isMultiTurn
            ? state.multiTurnTotalHunts + validResponseCount
            : validResponseCount;

        const judgeSystemPrompt = state.notebook?.judge_system_prompt || '';

        const judgePromptTemplate = `Question\n{prompt}\n\nStudent Response\n{model_response}\n\nStandard Response\n{standard_response}\n\nEvaluation Criteria\n{criteria}`;

        // judge_prompt_template — only saved for Turn-1
        cells.push({ heading: `Turn-1: judge_prompt_template`, content: judgePromptTemplate });

        const breakingTurnNum = state.currentTurn || 1;

        // Slot cells for breaking turn (variable count)
        selectedResults.forEach((result, idx) => {
            const slotNum = idx + 1;
            const rowNum = selectedRowNumbers[idx];
            const review = state.humanReviews[`row_${rowNum}`] || null;
            const modelName = _modelCellName(result.model);

            cells.push({ heading: `${modelName}_${slotNum}`, content: _slotModelResponse(result) });
            cells.push({ heading: `llm_judge_${slotNum}`,     content: _slotLlmJudge(result) });
            cells.push({ heading: `human_judge_${slotNum}`,   content: _slotHumanJudge(review) });
            cells.push({ heading: `reasoning_trace_${slotNum}`, content: _slotReasoningTrace(result) });
        });

        // ── Hunt metadata cells ────────────────────────────────────────────────
        // Collect config for every completed turn (previous + current breaking turn).
        // If all turns share the same hunt model, judge model, and hunt mode → save
        // flat (no prefix). Otherwise save per-turn with Turn_N_ prefix.

        const _curHuntModelId  = state.config.models?.[0] || '';
        const _curJudgeModelId = state.config.judge_model  || '';
        const _curHuntModeId   = state.config.hunt_mode    || '';

        const _allTurnConfigs = [
            ...state.turns.map(t => ({
                turnNumber:    t.turnNumber,
                huntModelId:   t.huntModelId   || '',
                huntModelName: t.huntModelName || getModelDisplayName(t.huntModelId || ''),
                judgeModelId:  t.judgeModelId  || '',
                judgeModelName:t.judgeModel    || getModelDisplayName(t.judgeModelId || ''),
                huntModeId:    t.huntModeId    || '',
                huntModeName:  t.huntModeName  || t.huntModeId || '',
                results:       t.results       || [],
                huntCount:     t.huntCount     || (t.results || []).length,
            })),
            {
                turnNumber:    breakingTurnNum,
                huntModelId:   _curHuntModelId,
                huntModelName: getModelDisplayName(_curHuntModelId),
                judgeModelId:  _curJudgeModelId,
                judgeModelName:getModelDisplayName(_curJudgeModelId),
                huntModeId:    _curHuntModeId,
                huntModeName:  getHuntModeById(_curHuntModeId)?.name || _curHuntModeId,
                results:       state.allResponses,
                huntCount:     validResponseCount,
            },
        ];

        const _calcPassRate = (results) => {
            const total   = (results || []).length;
            if (total === 0) return '0% (0/0)';
            const passing = results.filter(r => {
                const s = r.judge_score ?? r.score ?? null;
                return s !== null && Number(s) > 0;
            }).length;
            return `${Math.round((passing / total) * 100)}% (${passing}/${total})`;
        };

        const _allSame = _allTurnConfigs.length <= 1 || _allTurnConfigs.every(t =>
            t.huntModelId  === _allTurnConfigs[0].huntModelId  &&
            t.judgeModelId === _allTurnConfigs[0].judgeModelId &&
            t.huntModeId   === _allTurnConfigs[0].huntModeId
        );

        if (_allSame) {
            const _cfg         = _allTurnConfigs[0];
            const _allResults  = _allTurnConfigs.flatMap(t => t.results || []);
            cells.push({ heading: 'Total_Hunts',  content: String(totalAttempts) });
            cells.push({ heading: 'Pass_Rate',    content: _calcPassRate(_allResults) });
            cells.push({ heading: 'Hunt_Mode',    content: _cfg.huntModeName });
            cells.push({ heading: 'Hunt_Model',   content: _cfg.huntModelName });
            cells.push({ heading: 'Judge_Model',  content: _cfg.judgeModelName });
        } else {
            _allTurnConfigs.forEach(t => {
                const _p = `Turn_${t.turnNumber}_`;
                cells.push({ heading: `${_p}Total_Hunts`,  content: String(t.huntCount) });
                cells.push({ heading: `${_p}Pass_Rate`,    content: _calcPassRate(t.results) });
                cells.push({ heading: `${_p}Hunt_Mode`,    content: t.huntModeName });
                cells.push({ heading: `${_p}Hunt_Model`,   content: t.huntModelName });
                cells.push({ heading: `${_p}Judge_Model`,  content: t.judgeModelName });
            });
        }

        const result = await progressiveSaveToColab(cells);

        if (!result.success) {
            throw new Error(result.message || 'Progressive save failed');
        }

        playFinalSubmission();
        showToast(`Submitted to Colab! (${cells.length} cells saved)`, 'success');
        triggerColabConfetti();

        btn.textContent = 'Submitted';
        btn.disabled = true;

    } catch (error) {
        console.error('submitToColab error:', error);
        playFinalSubmissionError();
        showError(error, { operation: 'Submit to Colab', retry: () => submitToColab() });
        btn.disabled = false;
        btn.textContent = originalText;
    }
}
