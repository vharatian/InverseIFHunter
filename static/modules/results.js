/**
 * results.js — barrel re-export facade for Response Slideouts, Selection, Review,
 * Grading, Export.
 *
 * Implementation now lives in `./results/*.js`. This file preserves the original
 * import path and export surface so existing consumers work unchanged.
 */

export {
    isResultBreaking,
    isResultPassing,
    isResultError,
    countBreakingPassing,
    getStatusDisplay,
    getCriterionDisplay,
    validateSelectionForMode,
} from './results/resultModel.js';

export {
    toggleSelectionSectionCard,
    collapseSelectionSectionCard,
    expandSelectionSectionCard,
    initSelectionSectionCollapse,
    setReviewModeButtonsDisabled,
} from './results/selectionSection.js';

export {
    openResponseSlideout,
    closeResponseSlideout,
    openSelectionDetailSlideout,
} from './results/responseSlideout.js';

export {
    updateGradingProgressHeader,
    openGradingSlideout,
    setupGradingSlideoutEvents,
    submitGradingReview,
    closeGradingSlideout,
    toggleSelectionResponse,
} from './results/gradingSlideout.js';

export {
    handleHuntComplete,
    fetchAllResponses,
    fetchAllResponsesAndShowSelection,
} from './results/huntCompleteAndFetch.js';

export { exportNotebook } from './results/exportNotebook.js';

export {
    clearPreviousResults,
    formatLLMCriteria,
    renderJudgeExplanation,
    formatJudgeCriteriaDisplay,
    htmlToPlainText,
    warmupConnections,
} from './results/clearAndFormat.js';

export {
    displaySelectionCards,
    refreshSelectionTable,
    toggleHuntSelection,
    toggleDetailsRow,
    updateSelectionCount,
} from './results/selectionTable.js';

export {
    confirmSelection,
    displaySelectedForReview,
    handleRefreshAlignmentClick,
    disableSelectionCheckboxes,
    enableSelectionCheckboxes,
    handleChangeSelection,
    updateReviewProgress,
} from './results/selectionConfirmAndProgress.js';

export {
    applyLlmRevealedUi,
    revealLLMJudgments,
    displayBreakingResults,
    createResultCard,
    createResultCardFull,
    handleHumanReview,
    submitHumanReview,
    revealLLMJudge,
    checkAllReviewsComplete,
} from './results/llmRevealAndReviewCards.js';

export { initSlideoutResize } from './results/slideoutResize.js';
