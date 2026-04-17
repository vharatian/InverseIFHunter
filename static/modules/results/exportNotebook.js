/**
 * results/exportNotebook.js — Export notebook to .ipynb with reviews included.
 */

import { state } from '../state.js';
import { showToast, showError } from '../celebrations.js?v=43';
import { persistTrainerUi } from '../alignment.js';

export async function exportNotebook() {
    if (!state.sessionId) {
        showToast('No session to export. Please upload a notebook first.', 'error');
        return;
    }

    if (!state.results || state.results.length === 0) {
        showToast('No hunt results to export. Run a hunt first.', 'warning');
        return;
    }

    const selectedRowNumbers = state.selectedRowNumbers || [];
    const reviewKeys = selectedRowNumbers.map(rn => `row_${rn}`);
    const reviews = reviewKeys.map(key => state.humanReviews[key]).filter(r => r);
    const reviewCount = reviews.length;
    const requiredCount = selectedRowNumbers.length;

    if (requiredCount === 0) {
        showToast('No hunts selected for export.', 'error');
        return;
    }

    if (reviewCount < requiredCount) {
        showToast(`Cannot export: Only ${reviewCount}/${requiredCount} reviews completed. Please complete all reviews before exporting.`, 'error');
        return;
    }

    try {
        showToast('Preparing export with human reviews...', 'info');

        await persistTrainerUi();

        const reviewData = await fetch(`api/save-reviews/${state.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviews: state.humanReviews || {} })
        });

        if (!reviewData.ok) {
            const err = await reviewData.json();
            throw new Error(err.detail || 'Failed to save reviews');
        }

        const exportUrl = `api/export-notebook/${state.sessionId}?include_reasoning=true`;

        const a = document.createElement('a');
        a.href = exportUrl;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            showToast('Download started. The notebook includes all reviews!', 'success');
        }, 1000);
    } catch (error) {
        console.error('Export error:', error);
        showError(error, { operation: 'Export' });
    }
}
