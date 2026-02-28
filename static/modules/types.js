/**
 * Model Hunter - Shared Type Definitions
 * @module types
 */

/**
 * @typedef {Object} HuntResult
 * @property {string} model - Model ID
 * @property {string} response - Main response text
 * @property {number|null} score - Legacy score field
 * @property {number|null} judge_score - Judge score (0 or 1)
 * @property {boolean} is_breaking - Whether result is breaking
 * @property {Object} grading_basis - Criteria grades { "C1": "PASS", "C2": "FAIL" }
 * @property {string} explanation - Judge explanation
 */

/**
 * @typedef {Object} Turn
 * @property {number} turnNumber - 1-based turn index
 * @property {string} prompt - Prompt for this turn
 * @property {string} criteria - Criteria markdown
 * @property {HuntResult[]} results - List of hunt results
 * @property {Object} selectedResponse - The passing response selected for next turn
 */

/**
 * @typedef {Object} AppState
 * @property {string|null} sessionId - Current session UUID
 * @property {string|null} notebook - Uploaded notebook name (if any)
 * @property {Turn[]} turns - History of completed turns
 * @property {HuntResult[]} allResponses - Responses for current turn
 * @property {boolean} isHunting - Whether a hunt is active
 * @property {number} totalHuntsCount - Global hunt count
 */

export const Types = {}; // Placeholder export
