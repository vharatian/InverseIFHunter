/**
 * Review sync: submit for review, resubmit, show review_status and reviewer feedback.
 * Uses GET /api/session/{id} and POST submit-for-review / resubmit.
 */
import { state } from './state.js';
import { createPoller } from './poll.js';
import { setReviewStatus } from './autosave.js';

const BLOCK_ID = 'reviewSyncBlock';
const STATUS_ID = 'reviewSyncStatus';
const FEEDBACK_ID = 'reviewSyncFeedback';
const ACTIONS_ID = 'reviewSyncActions';

/**
 * Refresh the review sync block: fetch session, render status, feedback (if returned), and buttons.
 * Call when sessionId is set or after completing 4 reviews / submitting / resubmitting.
 * @param {string} [sessionId] - Defaults to state.sessionId
 */
export async function refreshReviewSync(sessionId) {
    const sid = sessionId || state.sessionId;
    const block = document.getElementById(BLOCK_ID);
    const statusEl = document.getElementById(STATUS_ID);
    const feedbackEl = document.getElementById(FEEDBACK_ID);
    const actionsEl = document.getElementById(ACTIONS_ID);
    if (!block || !statusEl || !actionsEl) return;

    if (!sid) {
        block.classList.add('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/session/${sid}`, { cache: 'no-store' });
        if (!res.ok) {
            block.classList.add('hidden');
            return;
        }
        const data = await res.json();
        const reviewStatus = data.review_status || 'draft';
        const reviewFeedback = data.review_feedback || null;
        const reviewRound = data.review_round || 0;
        const maxRounds = data.max_rounds || 5;

        setReviewStatus(reviewStatus);
        block.classList.remove('hidden');
        const roundInfo = reviewRound > 0 ? ` (Round ${reviewRound} of ${maxRounds})` : '';
        statusEl.textContent = `Review status: ${reviewStatus}${roundInfo}`;
        statusEl.className = 'review-sync-status';

        if (feedbackEl) {
            if ((reviewStatus === 'returned' || reviewStatus === 'rejected') && reviewFeedback) {
                feedbackEl.classList.remove('hidden');
                const prefix = reviewStatus === 'rejected' ? 'REJECTED — ' : '';
                const overall = reviewFeedback.overall_comment || '';
                const sections = reviewFeedback.section_comments || reviewFeedback.section_feedback || [];
                const parts = [overall ? `${prefix}Overall: ${overall}` : (prefix || '')];
                sections.forEach(s => {
                    const c = s.comment || '';
                    if (c) parts.push(`${s.section_id || ''}: ${c}`);
                });
                feedbackEl.textContent = parts.filter(Boolean).join('\n') || 'No comments.';
            } else {
                feedbackEl.classList.add('hidden');
                feedbackEl.textContent = '';
            }
        }

        actionsEl.innerHTML = '';
        const canSubmit = data.can_submit_for_review === true;
        if (reviewStatus === 'draft') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-primary';
            btn.textContent = canSubmit ? 'Submit for review' : 'Submit for review (complete 4 human reviews + Quality Check first)';
            btn.id = 'submitForReviewBtn';
            btn.disabled = !canSubmit;
            if (canSubmit) btn.addEventListener('click', () => submitForReview(sid));
            actionsEl.appendChild(btn);
        } else if (reviewStatus === 'returned') {
            const canResubmit = data.can_resubmit === true;
            const qcDone = data.qc_done === true;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-primary';
            if (canResubmit) {
                btn.textContent = 'Resubmit for review';
                btn.addEventListener('click', () => resubmitForReview(sid));
            } else {
                btn.textContent = qcDone
                    ? 'Resubmit for review (complete 4 reviews first)'
                    : 'Resubmit for review (re-run Quality Check first)';
                btn.disabled = true;
            }
            btn.id = 'resubmitForReviewBtn';
            actionsEl.appendChild(btn);
        }

        if (reviewStatus === 'escalated') {
            const notice = document.createElement('div');
            notice.className = 'review-sync-escalated';
            notice.textContent = `This task has been escalated to an admin for review (max ${maxRounds} rounds reached).`;
            actionsEl.appendChild(notice);
        }

        // Show approval status to trainer (Colab save is handled by the reviewer)
        const colabStatusEl = document.getElementById('colabSaveStatus');
        if (colabStatusEl) {
            if (reviewStatus === 'approved') {
                colabStatusEl.textContent = 'Approved — awaiting final submission by reviewer.';
                colabStatusEl.classList.remove('hidden');
            } else {
                colabStatusEl.classList.add('hidden');
            }
        }
    } catch {
        block.classList.add('hidden');
    }
}

async function submitForReview(sessionId) {
    const btn = document.getElementById('submitForReviewBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch(`/api/session/${sessionId}/submit-for-review`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || res.statusText);
        await refreshReviewSync(sessionId);
    } catch (e) {
        if (btn) btn.disabled = false;
        alert(e.message || 'Failed to submit for review');
    }
}

async function resubmitForReview(sessionId) {
    const btn = document.getElementById('resubmitForReviewBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch(`/api/session/${sessionId}/resubmit`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || res.statusText);
        if (data.escalated) {
            alert(`This task has been escalated to an admin (maximum ${data.review_round} rounds reached).`);
        }
        await refreshReviewSync(sessionId);
    } catch (e) {
        if (btn) btn.disabled = false;
        alert(e.message || 'Failed to resubmit');
    }
}

export function initReviewSync() {
    if (state.sessionId) refreshReviewSync(state.sessionId);
    createPoller(() => {
        if (state.sessionId) refreshReviewSync(state.sessionId);
    }, 15_000);
}
