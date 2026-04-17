import { elements } from '../dom.js';
import { state } from '../state.js';
import { showToast, showError } from '../celebrations.js?v=43';
import { validatePromptLength } from '../editors.js';
import { syncActiveRunToNotebook } from '../testbed.js';
import { updateOriginalNotebookWithCell } from './ingest.js';
import { judgeReferenceResponse } from './reference-judge.js';
import { resetAllStatuses } from '../autosave.js';

export async function saveCell(cellType) {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }

    if (cellType === 'prompt' && !validatePromptLength()) {
        showToast('Cannot save: Prompt length is outside the required range', 'error');
        return;
    }

    let content = '';
    let cellHeading = '';

    syncActiveRunToNotebook();
    const nb = state.notebook || {};
    switch (cellType) {
        case 'prompt':
            content = nb.prompt || '';
            cellHeading = 'prompt';
            break;
        case 'response':
            content = nb.response || '';
            cellHeading = 'response';
            break;
        case 'response_reference':
            content = (nb.response_reference || '').trim();
            if (!content) {
                showToast('Please ensure Model Reference is in valid format', 'error');
                return;
            }
            cellHeading = 'response_reference';
            break;
        case 'judge_system_prompt':
            content = nb.judge_system_prompt || '';
            cellHeading = 'judge_system_prompt';
            break;
        default:
            showToast('Unknown cell type', 'error');
            return;
    }

    if (!content.trim()) {
        showToast(`${cellType} cannot be empty`, 'error');
        return;
    }

    try {
        let btn = null;
        if (cellType === 'prompt') {
            btn = elements.savePromptBtn;
        } else if (cellType === 'response') {
            btn = elements.saveResponseBtn;
        } else if (cellType === 'response_reference') {
            btn = elements.saveModelRefBtn;
        } else if (cellType === 'judge_system_prompt') {
            btn = elements.saveJudgeBtn;
        }

        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving...';
        }

        const response = await fetch(`api/update-notebook-cell/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cell_type: cellHeading,
                content: content
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to save');
        }

        await response.json();
        showToast(`${cellType} saved to Colab!`, 'success');

        state.unsavedChanges[cellType === 'response_reference' ? 'modelRef' : cellType] = false;

        updateOriginalNotebookWithCell(cellHeading, content);

        if (cellType === 'response') {
            await judgeReferenceResponse(undefined);
        }

    } catch (error) {
        showError(error, { operation: `Save ${cellType}` });
    } finally {
        let btn = null;
        let originalText = '';
        if (cellType === 'prompt') {
            btn = elements.savePromptBtn;
            originalText = 'Save Prompt';
        } else if (cellType === 'response') {
            btn = elements.saveResponseBtn;
            originalText = 'Save Response';
        } else if (cellType === 'response_reference') {
            btn = elements.saveModelRefBtn;
            originalText = 'Save Criteria';
        } else if (cellType === 'judge_system_prompt') {
            btn = elements.saveJudgeBtn;
            originalText = 'Save Judge';
        }

        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

export async function saveAllCells() {
    if (!state.sessionId) {
        showToast('Please load a notebook first', 'error');
        return;
    }

    syncActiveRunToNotebook();

    if (!state.isMultiTurn && !validatePromptLength()) {
        showToast('Cannot save: Prompt length is outside the required range', 'error');
        return;
    }

    const nb = state.notebook || {};
    const cellsToSave = [];

    if ((nb.prompt || '').trim()) {
        cellsToSave.push({ cell_type: 'prompt', content: nb.prompt });
    }

    if ((nb.response || '').trim()) {
        cellsToSave.push({ cell_type: 'response', content: nb.response });
    }

    const criteriaContent = (nb.response_reference || '').trim();
    if (criteriaContent) {
        cellsToSave.push({ cell_type: 'response_reference', content: criteriaContent });
    }

    if ((nb.judge_system_prompt || '').trim()) {
        cellsToSave.push({ cell_type: 'judge_system_prompt', content: nb.judge_system_prompt });
    }

    if (cellsToSave.length === 0) {
        showToast('No changes to save', 'info');
        return;
    }

    try {
        if (elements.saveAllBtn) {
            elements.saveAllBtn.disabled = true;
            elements.saveAllBtn.textContent = 'Saving...';
        }

        const response = await fetch(`api/update-notebook-cells/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cells: cellsToSave })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to save');
        }

        await response.json();
        showToast(`All changes saved to Colab! (${cellsToSave.length} cells)`, 'success');

        Object.keys(state.unsavedChanges).forEach(key => {
            state.unsavedChanges[key] = false;
        });
        resetAllStatuses();

        cellsToSave.forEach(cell => {
            updateOriginalNotebookWithCell(cell.cell_type, cell.content);
        });

        if (cellsToSave.some(c => c.cell_type === 'response')) {
            await judgeReferenceResponse(undefined);
        }

    } catch (error) {
        showError(error, { operation: 'Save' });
    } finally {
        if (elements.saveAllBtn) {
            elements.saveAllBtn.disabled = false;
            elements.saveAllBtn.textContent = 'Save All & Judge';
        }
    }
}
