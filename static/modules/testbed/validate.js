/**
 * testbed/validate.js — leaf module for judge-output-format validation.
 * Imported by notebook/* modules; keeps no imports from other testbed modules to avoid cycles.
 */

import { REQUIRED_JUDGE_FORMAT } from './constants.js';

/**
 * Check if judge system prompt contains the required output format:
 * JSON with "result" (PASS/FAIL) and "explanation" keys.
 * @param {string} prompt - Judge system prompt text
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateJudgeOutputFormat(prompt) {
    if (!prompt || !prompt.trim()) {
        return { valid: false, message: 'Judge System Prompt is required.' };
    }
    const p = prompt.trim();
    if (!p.includes(REQUIRED_JUDGE_FORMAT.result)) {
        return { valid: false, message: 'Your judge system prompt must include the required output format: JSON with "result" (PASS/FAIL) and "explanation" keys. Please add this format before judging.' };
    }
    if (!p.includes(REQUIRED_JUDGE_FORMAT.explanation)) {
        return { valid: false, message: 'Your judge system prompt must include the required output format: JSON with "result" (PASS/FAIL) and "explanation" keys. Please add this format before judging.' };
    }
    if (!p.includes(REQUIRED_JUDGE_FORMAT.pass) || !p.includes(REQUIRED_JUDGE_FORMAT.fail)) {
        return { valid: false, message: 'Your judge system prompt must specify PASS and FAIL as possible values for "result". Please add this format before judging.' };
    }
    return { valid: true };
}
