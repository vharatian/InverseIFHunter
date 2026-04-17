import { elements } from '../dom.js';
import { state } from '../state.js';
import { adminBypass, getConfigValue } from '../config.js';
import { escapeHtml } from '../utils.js';
import { showToast, showError } from '../celebrations.js?v=43';
export function invalidateReferenceJudge() {
    if ((state.adminMode && adminBypass('reference_validation')) || getConfigValue('bypass_hunt_criteria', false)) return;
    state.referenceValidated = false;
    const responseRef = state.notebook?.response_reference || '';
    validateModelReferenceAndCriteria(responseRef);
}

// Validate Model Reference: JSON format AND criteria completeness
export function validateModelReferenceAndCriteria(responseReference) {
    if (state.adminMode && adminBypass('reference_validation')) {
        if (elements.startHuntBtn) { elements.startHuntBtn.disabled = false; elements.startHuntBtn.title = 'Admin mode'; }
        return;
    }
    // Step 1: Check JSON format
    const jsonValidation = validateModelReferenceJSON(responseReference);
    state.modelRefValid = jsonValidation.valid;
    
    if (!jsonValidation.valid) {
        // JSON is invalid - show error and disable hunt
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--danger); margin-bottom: 1rem; padding: 0.75rem; background: var(--danger-bg); border-radius: 8px;">
                    <strong>Invalid JSON Format</strong><br>
                    ${escapeHtml(jsonValidation.error)}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(responseReference || 'No content')}</pre>
            `;
        }
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        return;
    }
    
    // Step 2: JSON is valid, now check criteria completeness
    let currentCriteria;
    try {
        currentCriteria = parseCriteria(responseReference);
    } catch (error) {
        console.error('Failed to parse criteria:', error);
        showError(error, { operation: 'Parse criteria' });
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        return;
    }
    const currentCriteriaIds = new Set(currentCriteria.map(c => c.id));
    const initialCriteriaIds = new Set((state.initialCriteria || []).map(c => c.id));
    const missingCriteriaIds = [...initialCriteriaIds].filter(id => !currentCriteriaIds.has(id));
    
    if (missingCriteriaIds.length > 0) {
        // Criteria are missing - show warning and disable hunt
        const missingList = missingCriteriaIds.map(id => {
            const criterion = (state.initialCriteria || []).find(c => c.id === id);
            return `• ${id}: ${criterion ? criterion.criteria.substring(0, 60) + '...' : 'Description not available'}`;
        }).join('<br>');
        
        if (elements.modelrefPreview) {
            elements.modelrefPreview.innerHTML = `
                <div style="color: var(--warning); margin-bottom: 1rem; padding: 0.75rem; background: var(--warning-bg); border-radius: 8px;">
                    <strong>Missing Criteria</strong><br>
                    The following criteria from the original notebook are missing from Model Reference:<br>
                    ${missingList}
                </div>
                <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(responseReference || 'No content')}</pre>
            `;
        }
        if (elements.startHuntBtn) {
            elements.startHuntBtn.disabled = false;
            elements.startHuntBtn.title = '';
        }
        showToast(`Missing criteria: ${missingCriteriaIds.join(', ')}`, 'warning');
        return;
    }
    
    // Step 3: JSON is valid AND all criteria are present
    // Check if reference was already validated (judged and passed)
    // If already validated, enable the button; otherwise keep it disabled until judging
    if (elements.modelrefPreview) {
        elements.modelrefPreview.textContent = responseReference || 'No model reference criteria found';
    }
    if (elements.startHuntBtn) {
        elements.startHuntBtn.disabled = false;
        elements.startHuntBtn.title = '';
    }
}

// Validate that Model Reference is valid JSON format with criteria
// Only validates the JSON array between [ and ], ignoring any text outside
export function validateModelReferenceJSON(responseReference) {
    if (!responseReference || !responseReference.trim()) {
        return { valid: false, error: 'Model Reference is empty' };
    }
    
    try {
        // Extract only the JSON array between [ and ]
        const arrayMatch = responseReference.match(/\[[\s\S]*?\]/);
        
        if (!arrayMatch) {
            return { valid: false, error: 'Model Reference must contain a JSON array between [ and ] brackets' };
        }
        
        const jsonArrayStr = arrayMatch[0];
        const arr = JSON.parse(jsonArrayStr);
        
        if (!Array.isArray(arr)) {
            return { valid: false, error: 'Content between [ and ] must be a JSON array' };
        }
        
        if (arr.length === 0) {
            return { valid: false, error: 'JSON array cannot be empty' };
        }
        
        // Validate each item has id and criteria fields
        for (let idx = 0; idx < arr.length; idx++) {
            const item = arr[idx];
            if (typeof item !== 'object' || item === null) {
                return { valid: false, error: `Criterion at index ${idx} must be a JSON object` };
            }
            if (!item.id) {
                return { valid: false, error: `Criterion at index ${idx} is missing 'id' field` };
            }
            // Check for criteria1, criteria2, etc. fields
            const hasCriteria = Object.keys(item).some(key => key.startsWith('criteria') && key !== 'id');
            if (!hasCriteria) {
                return { valid: false, error: `Criterion at index ${idx} (id: ${item.id}) is missing a 'criteria' field` };
            }
        }
        
        return { valid: true };
        
    } catch (e) {
        return { valid: false, error: `JSON parse error: ${e.message}` };
    }
}

// Parse criteria from response_reference text
// Supports multiple formats:
// 1. JSON array: [{"id": "C1", "criteria1": "..."}, ...]
// 2. Plain text: "C1: ...\nC2: ...\nC3: ..."
export function parseCriteria(responseReference) {
    
    if (!responseReference || !responseReference.trim()) {
        const error = 'Empty response_reference - cannot parse criteria';
        console.error(error);
        throw new Error(error);
    }
    
    // Clean the input - remove any leading/trailing whitespace
    const cleaned = responseReference.trim();
    
    try {
        // First, try to parse the entire string as JSON (most common case)
        let criteriaArray = null;
        let jsonArrayStr = null;
        let isPlainTextFormat = false;
        
        try {
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                criteriaArray = parsed;
                jsonArrayStr = cleaned;
            } else {
                // It's JSON but not an array
                throw new Error('Parsed JSON is not an array');
            }
        } catch (jsonParseError) {
            // Not pure JSON, try to extract JSON array from text
            
            // Try to find JSON array with balanced brackets (most robust method)
            let bracketCount = 0;
            let startIndex = -1;
            let arrayMatch = null;
            
            for (let i = 0; i < cleaned.length; i++) {
                if (cleaned[i] === '[') {
                    if (bracketCount === 0) startIndex = i;
                    bracketCount++;
                } else if (cleaned[i] === ']') {
                    bracketCount--;
                    if (bracketCount === 0 && startIndex >= 0) {
                        arrayMatch = cleaned.substring(startIndex, i + 1);
                        break;
                    }
                }
            }
            
            // If balanced bracket matching failed, try regex as fallback
            if (!arrayMatch) {
                // Try greedy match (captures full array including nested arrays)
                const greedyMatch = cleaned.match(/\[[\s\S]*\]/);
                if (greedyMatch) {
                    arrayMatch = greedyMatch[0];
                } else {
                    // Try non-greedy
                    const nonGreedyMatch = cleaned.match(/\[[\s\S]*?\]/);
                    if (nonGreedyMatch) {
                        arrayMatch = nonGreedyMatch[0];
                    }
                }
            }
            
            if (arrayMatch) {
                try {
                    jsonArrayStr = arrayMatch;
                    criteriaArray = JSON.parse(jsonArrayStr);
                } catch (parseError) {
                    console.error('Failed to parse extracted array:', parseError);
                    console.error('Extracted string:', arrayMatch.substring(0, 200));
                    // Fall through to try plain text format
                }
            }
            
              // If still no criteriaArray, try plain text format: "C1: ...\nC2: ..."
              if (!criteriaArray) {
                  const plainTextPattern = /^(C\d+)\s*[:：]\s*(.+)$/gim;
                  const matches = [...cleaned.matchAll(plainTextPattern)];
                  
                  if (matches.length > 0) {
                      criteriaArray = matches.map((match) => ({
                          id: match[1].toUpperCase(),
                          criteria: match[2].trim()
                      }));
                      isPlainTextFormat = true;
                } else {
                    // No format matched
                    const error = 'No JSON array or plain text criteria (C1:, C2:, etc.) found in response_reference';
                    console.error(error);
                    console.error('Response reference content (first 500 chars):', cleaned.substring(0, 500));
                    throw new Error(error);
                }
            }
        }
        
        if (!Array.isArray(criteriaArray) || criteriaArray.length === 0) {
            const error = 'JSON array is empty or invalid - must contain at least one criterion';
            console.error(error);
            throw new Error(error);
        }
        
        // Parse each criterion item
            const criteria = [];
        for (let idx = 0; idx < criteriaArray.length; idx++) {
            const item = criteriaArray[idx];
            
            if (typeof item !== 'object' || item === null) {
                continue;
            }
            
            const c_id = item.id || `C${idx + 1}`;
            
            // Look for criteria1, criteria2, etc. fields
            let criteriaText = null;
            for (const key of Object.keys(item)) {
                if (key.startsWith('criteria') && key !== 'id') {
                    criteriaText = item[key];
                    break;
                }
            }
            
            // Fallback to description or other fields
            if (!criteriaText) {
                criteriaText = item.description || item.criteria || item.text || JSON.stringify(item);
            }
            
            if (criteriaText) {
                criteria.push({ id: c_id, criteria: criteriaText });
            }
        }
        
        if (criteria.length > 0) {
            return criteria;
        }
        
        // Try alternative format: JSON object with C1, C2 keys
        const jsonObjMatch = responseReference.match(/\{[\s\S]*?"C\d+"[\s\S]*?\}/);
        if (jsonObjMatch) {
            try {
                const data = JSON.parse(jsonObjMatch[0]);
                const criteria = [];
                for (const key of Object.keys(data)) {
                    if (/^C\d+$/i.test(key)) {
                        const value = data[key];
                        const desc = typeof value === 'string' ? value : 
                                     (value?.description || value?.criteria || JSON.stringify(value));
                        criteria.push({ id: key.toUpperCase(), criteria: desc });
                    }
                }
                if (criteria.length > 0) {
                    return criteria;
                }
            } catch (e) {
                // Continue to throw error
            }
        }
        
        const error = 'Could not extract valid criteria from response_reference JSON array';
        console.error(error);
        throw new Error(error);
        
    } catch (e) {
        if (e instanceof SyntaxError || e.message.includes('JSON')) {
            const error = `JSON parse error in response_reference: ${e.message}`;
            console.error(error);
            throw new Error(error);
        }
        // Re-throw if it's already our custom error
        throw e;
    }
}

export function getDefaultCriteria() {
    return [
        { id: 'C1', criteria: 'Response meets formatting requirements' },
        { id: 'C2', criteria: 'Response follows exact instructions' },
        { id: 'C3', criteria: 'Response avoids violations' },
        { id: 'C4', criteria: 'Response maintains context' }
    ];
}
