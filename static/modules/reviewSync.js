/**
 * Review sync: submit for review, resubmit, show review_status and reviewer feedback.
 * Uses GET /api/session/{id} and POST submit-for-review / resubmit.
 */
import { state } from './state.js';
import { getHuntTimingForSubmit } from './hunt.js';
import { createPoller } from './poll.js';
import { setReviewStatus } from './autosave.js';
import { applySectionLocksFromFeedback } from './sessionHydrator.js';

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
        const res = await fetch(`api/session/${sid}`, { cache: 'no-store' });
        if (!res.ok) {
            block.classList.add('hidden');
            return;
        }
        const data = await res.json();
        const reviewStatus = data.review_status || 'draft';
        const reviewFeedback = data.review_feedback || null;
        const reviewRound = data.review_round || 0;
        const maxRounds = data.max_rounds || 5;

        state.reviewFeedback = reviewFeedback;
        setReviewStatus(reviewStatus);
        block.classList.remove('hidden');
        const roundInfo = reviewRound > 0 ? ` · Round ${reviewRound} of ${maxRounds}` : '';
        statusEl.innerHTML = `<span class="review-sync-status-label">Review status</span><span class="review-sync-status-badge review-sync-status-${reviewStatus}">${reviewStatus}${roundInfo}</span>`;
        statusEl.className = 'review-sync-status';

        if (feedbackEl) {
            if ((reviewStatus === 'returned' || reviewStatus === 'rejected') && reviewFeedback) {
                feedbackEl.classList.remove('hidden');
                const overall = reviewFeedback.overall_comment || '';
                if (reviewStatus === 'rejected') {
                    feedbackEl.innerHTML = `<strong style="color:var(--danger)">Rejected</strong>${overall ? ` — ${overall}` : ''}`;
                } else {
                    feedbackEl.textContent = overall || 'No overall comment from reviewer.';
                }
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
            const acknowledgedAt = data.acknowledged_at || null;
            const canResubmit = data.can_resubmit === true;
            const qcDone = data.qc_done === true;

            if (!acknowledgedAt) {
                // Acknowledge button + hint stacked together
                const ackWrap = document.createElement('div');
                ackWrap.className = 'review-sync-ack-wrap';

                const ackBtn = document.createElement('button');
                ackBtn.type = 'button';
                ackBtn.className = 'btn btn-primary review-sync-ack-btn';
                ackBtn.id = 'acknowledgeFeedbackBtn';
                ackBtn.textContent = "I've read the feedback — Acknowledge";
                ackBtn.addEventListener('click', () => acknowledgeFeedback(sid));

                const hint = document.createElement('p');
                hint.className = 'review-sync-ack-hint';
                hint.textContent = 'Acknowledge once you have read the reviewer comments above. Then you can resubmit.';

                ackWrap.appendChild(ackBtn);
                ackWrap.appendChild(hint);
                actionsEl.appendChild(ackWrap);
            }

            // Resubmit button (separate row)
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'resubmitForReviewBtn';
            if (acknowledgedAt && canResubmit) {
                btn.className = 'btn btn-primary review-sync-resubmit-btn';
                btn.textContent = 'Resubmit for review';
                btn.addEventListener('click', () => resubmitForReview(sid));
            } else {
                btn.className = 'btn review-sync-resubmit-btn review-sync-resubmit-disabled';
                btn.textContent = !acknowledgedAt
                    ? 'Resubmit for review (acknowledge feedback first)'
                    : qcDone
                        ? 'Resubmit for review (complete 4 reviews first)'
                        : 'Resubmit for review (re-run Quality Check first)';
                btn.disabled = true;
            }
            actionsEl.appendChild(btn);
        }

        if (reviewStatus === 'escalated') {
            const notice = document.createElement('div');
            notice.className = 'review-sync-escalated';
            notice.textContent = `This task has been escalated to an admin for review (max ${maxRounds} rounds reached).`;
            actionsEl.appendChild(notice);
        }

        if ((reviewStatus === 'returned' || reviewStatus === 'rejected') && reviewFeedback?.revision_flags?.length) {
            applySectionLocksFromFeedback(reviewFeedback.revision_flags, reviewFeedback);
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
        const huntTiming = getHuntTimingForSubmit();
        const res = await fetch(`api/session/${sessionId}/submit-for-review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hunt_timing: huntTiming }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || res.statusText);
        await refreshReviewSync(sessionId);
    } catch (e) {
        if (btn) btn.disabled = false;
        alert(e.message || 'Failed to submit for review');
    }
}

async function acknowledgeFeedback(sessionId) {
    const btn = document.getElementById('acknowledgeFeedbackBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch(`api/session/${sessionId}/acknowledge`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || res.statusText);
        await refreshReviewSync(sessionId);
    } catch (e) {
        if (btn) btn.disabled = false;
        alert(e.message || 'Failed to acknowledge');
    }
}

async function resubmitForReview(sessionId) {
    const btn = document.getElementById('resubmitForReviewBtn');
    if (btn) btn.disabled = true;
    try {
        const huntTiming = getHuntTimingForSubmit();
        const res = await fetch(`api/session/${sessionId}/resubmit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hunt_timing: huntTiming }),
        });
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
