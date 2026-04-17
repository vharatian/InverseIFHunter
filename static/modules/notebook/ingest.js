import { elements } from '../dom.js';
import { state } from '../state.js';
import { clearHuntCount } from '../utils.js';
import { showToast, showError } from '../celebrations.js?v=43';
import { playFetchSuccess, playFetchError } from '../sounds.js?v=43';
import { getTrainerInfo } from '../auth.js';
import { showAppModal } from '../api.js';
import { updateModelOptions } from '../editors.js';
import { handleNotebookLoaded } from './session-load.js';

export async function syncTurnStatusFromBackend(sessionId) {
    try {
        const res = await fetch(`api/turn-status/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.is_multi_turn || !data.turns?.length) return;
        const sessionJudgeModel = data.judge_model || '';
        state.turns = (data.turns || []).map(t => ({
            turnNumber: t.turn_number ?? t.turnNumber,
            turn_number: t.turn_number ?? t.turnNumber,
            prompt: t.prompt ?? '',
            response_reference: t.response_reference ?? t.criteria ?? '',
            criteria: t.response_reference ?? t.criteria ?? '',
            response: t.selected_response ?? t.selectedResponse ?? t.response ?? null,
            selectedResponse: t.selected_response ?? t.selectedResponse ?? null,
            selected_response: t.selected_response ?? t.selectedResponse ?? null,
            judgeResult: t.judge_result ?? t.judgeResult ?? null,
            judge_result: t.judge_result ?? t.judgeResult ?? null,
            judgeModel: sessionJudgeModel,
            results: t.results ?? []
        }));
        state.conversationHistory = data.conversation_history || [];
        state.currentTurn = data.current_turn ?? 1;
        state.isMultiTurn = !!data.is_multi_turn;
        state.multiTurnTotalHunts = state.turns.reduce((sum, t) => sum + (t.results?.length || 0), 0);
        const { renderTurnHistoryTabs, updateTurnAwareUI } = await import('../multiturn.js');
        renderTurnHistoryTabs();
        updateTurnAwareUI();
    } catch (e) {
        console.debug('Turn status sync skipped:', e);
    }
}

export function updateOriginalNotebookWithCell(cellHeading, content) {
    if (!state.originalNotebookJson) {
        console.warn('Cannot update originalNotebookJson: not set');
        return;
    }

    try {
        const notebook = JSON.parse(state.originalNotebookJson);
        const cells = notebook.cells || [];

        const headingPattern = new RegExp(`\\*\\*\\[${cellHeading}\\]\\*\\*`, 'i');

        let cellIndex = cells.findIndex(cell => {
            const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            return headingPattern.test(source);
        });

        const formattedContent = `**[${cellHeading}]**\n\n${content}`;

        if (cellIndex >= 0) {
            cells[cellIndex].source = [formattedContent];
        } else {
            let insertIndex = cells.length;

            for (let i = 0; i < cells.length; i++) {
                const source = Array.isArray(cells[i].source) ? cells[i].source.join('') : (cells[i].source || '');
                if (/\*\*\[(qwen|nemotron|model)_\d\]\*\*/i.test(source)) {
                    insertIndex = i;
                    break;
                }
                if (/\*\*\[number_of_attempts_made\]\*\*/i.test(source)) {
                    insertIndex = i;
                    break;
                }
            }

            const newCell = {
                cell_type: 'markdown',
                id: `auto_${cellHeading}_${Date.now()}`,
                metadata: {},
                source: [formattedContent]
            };

            cells.splice(insertIndex, 0, newCell);
        }

        notebook.cells = cells;
        state.originalNotebookJson = JSON.stringify(notebook, null, 2);

    } catch (e) {
        console.error('Failed to update originalNotebookJson:', e);
    }
}

export function initFileUpload() {
    const dropzone = elements.fileDropzone;
    const input = elements.fileInput;

    if (dropzone && input) {
        dropzone.addEventListener('click', () => input.click());

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');

            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.ipynb')) {
                uploadFile(file);
            } else {
                showToast('Please upload a .ipynb file', 'error');
            }
        });

        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                uploadFile(file);
            }
        });
    }

    const setupFetchButton = () => {
        let fetchBtn = elements.fetchUrlBtn || document.getElementById('fetchUrlBtn');

        if (fetchBtn) {
            elements.fetchUrlBtn = fetchBtn;

            fetchBtn.onclick = null;

            const handleFetchClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                fetchFromUrl();
            };

            fetchBtn.addEventListener('click', handleFetchClick, true);

            fetchBtn.onclick = handleFetchClick;

            fetchBtn.disabled = false;
            fetchBtn.type = 'button';

            fetchBtn.style.pointerEvents = 'auto';
            fetchBtn.style.cursor = 'pointer';

        } else {
            console.error('fetchUrlBtn element not found during initialization');
            setTimeout(() => {
                const retryBtn = document.getElementById('fetchUrlBtn');
                if (retryBtn) {
                    setupFetchButton();
                } else {
                    console.error('Fetch button still not found after retry');
                }
            }, 100);
        }
    };

    setupFetchButton();

    const createBtn = document.getElementById('createNotebookBtn');
    if (createBtn) {
        createBtn.addEventListener('click', (e) => {
            e.preventDefault();
            createNotebook();
        });
    }

    if (elements.colabUrlInput) {
        elements.colabUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                fetchFromUrl();
            }
        });
    }
}

export async function uploadFile(file, forceNew = false) {
    const formData = new FormData();
    formData.append('file', file);

    try {
        showToast('Uploading notebook...', 'info');

        const trainerInfo = getTrainerInfo();
        const headers = {};
        if (trainerInfo) {
            headers['X-Trainer-Email'] = trainerInfo.email;
            headers['X-Trainer-Name'] = trainerInfo.name;
        }
        let url = 'api/upload-notebook';
        if (forceNew) url += '?force_new=true';
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }

        const data = await response.json();

        if (data.duplicate_found) {
            const choice = await _showDuplicateModal(data.task_id, data.existing_sessions);
            if (choice === 'resume') {
                document.dispatchEvent(new CustomEvent('open-existing-session', { detail: { sessionId: data.existing_sessions[0].session_id } }));
                return;
            }
            if (choice === 'new') {
                return uploadFile(file, true);
            }
            return;
        }

        await handleNotebookLoaded(data, false);

    } catch (error) {
        showError(error, { operation: 'Upload' });
    }
}

function _truncateModalLine(s, maxLen) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= maxLen) return t;
    return `${t.slice(0, maxLen - 1)}…`;
}

function _duplicateStatusLine(sess) {
    const rs = (sess.review_status || '').trim().toLowerCase();
    const hs = (sess.hunt_status || 'pending').trim().toLowerCase();
    const reviewLabel = !rs || rs === 'unknown' ? 'draft' : rs;
    return `Review: ${reviewLabel} · Hunt: ${hs || 'pending'}`;
}

async function _showDuplicateModal(taskId, existingSessions) {
    const sess = existingSessions[0];
    const statusLine = _duplicateStatusLine(sess);
    const preview = _truncateModalLine(sess.prompt_preview, 280);
    const message = preview
        ? `A session already exists for this notebook.\n\nPrompt: "${preview}"\n${statusLine}\n\nWould you like to resume the existing session or start a new one?`
        : `A session already exists for task "${taskId}".\n${statusLine}\n\nWould you like to resume the existing session or start a new one?`;
    return showAppModal({
        title: 'Task already exists',
        message,
        buttons: [
            { label: 'Resume existing', primary: true, value: 'resume' },
            { label: 'Start fresh', value: 'new' },
            { label: 'Cancel', value: 'cancel' },
        ],
    });
}

export async function fetchFromUrl(forceNew = false) {

    if (!elements.colabUrlInput) {
        elements.colabUrlInput = document.getElementById('colabUrlInput');
    }
    if (!elements.fetchUrlBtn) {
        elements.fetchUrlBtn = document.getElementById('fetchUrlBtn');
    }

    if (!elements.colabUrlInput) {
        console.error('colabUrlInput element not found');
        showToast('URL input field not found', 'error');
        return;
    }

    if (!elements.fetchUrlBtn) {
        console.error('fetchUrlBtn element not found');
        showToast('Load button not found', 'error');
        return;
    }

    const url = elements.colabUrlInput.value?.trim();
    if (!url) {
        showToast('Please enter a Colab URL', 'error');
        return;
    }

    try {
        showToast('Loading notebook from URL...', 'info');
        elements.fetchUrlBtn.disabled = true;
        elements.fetchUrlBtn.textContent = 'Loading...';

        const trainerInfo = getTrainerInfo();
        const response = await fetch('api/fetch-notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, trainer_email: trainerInfo?.email, trainer_name: trainerInfo?.name, force_new: forceNew })
        });


        if (!response.ok) {
            let errorMessage = 'Load failed';
            try {
                const error = await response.json();
                errorMessage = error.detail || error.message || 'Load failed';
            } catch (e) {
                errorMessage = `HTTP ${response.status}: ${response.statusText}`;
            }
            throw new Error(errorMessage);
        }

        const data = await response.json();

        if (data.duplicate_found) {
            const choice = await _showDuplicateModal(data.task_id, data.existing_sessions);
            if (choice === 'resume') {
                document.dispatchEvent(new CustomEvent('open-existing-session', { detail: { sessionId: data.existing_sessions[0].session_id } }));
                return;
            }
            if (choice === 'new') {
                return fetchFromUrl(true);
            }
            return;
        }

        await handleNotebookLoaded(data, true);
        playFetchSuccess();

    } catch (error) {
        console.error('Error fetching notebook:', error);
        playFetchError();
        showError(error, { operation: 'Load notebook', retry: fetchFromUrl });
    } finally {
        if (elements.fetchUrlBtn) {
            elements.fetchUrlBtn.disabled = false;
            elements.fetchUrlBtn.textContent = 'Load';
        }
    }
}

export async function createNotebook() {
    const btn = document.getElementById('createNotebookBtn');
    const titleInput = document.getElementById('newNotebookTitleInput');
    const title = titleInput?.value?.trim() || 'Trainer Notebook';

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
        showToast('Creating notebook in Google Drive...', 'info');

        const trainerInfo = getTrainerInfo();
        const response = await fetch('api/create-notebook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title,
                trainer_email: trainerInfo?.email || null,
                trainer_name: trainerInfo?.name || null,
            }),
        });

        if (!response.ok) {
            let errorMessage = 'Failed to create notebook';
            try {
                const err = await response.json();
                errorMessage = err.detail || err.message || errorMessage;
            } catch (_) { /* ignore */ }
            throw new Error(errorMessage);
        }

        const data = await response.json();

        data.notebook_url = data.notebook_url || null;
        data._file_id = data.file_id || null;

        showToast(
            data.shared_with
                ? `Notebook created and shared with ${data.shared_with}`
                : 'Notebook created in Drive',
            'success'
        );

        await handleNotebookLoaded(data, true, data.notebook_url);

    } catch (error) {
        console.error('Error creating notebook:', error);
        showError(error, { operation: 'Create notebook' });
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '+ New Notebook'; }
    }
}
