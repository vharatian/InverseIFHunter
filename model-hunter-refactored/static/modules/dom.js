/**
 * dom.js — DOM Element References & Constants
 * 
 * Central registry of all DOM element references used by the application.
 * Avoids scattered document.getElementById() calls across modules.
 */

/**
 * All DOM element references, queried once at load time.
 * @type {Object.<string, HTMLElement|null>}
 */
export const elements = {
    themeToggle: document.getElementById('themeToggle'),
    
    // Upload
    fileDropzone: document.getElementById('fileDropzone'),
    fileInput: document.getElementById('fileInput'),
    colabUrlInput: document.getElementById('colabUrlInput'),
    fetchUrlBtn: document.getElementById('fetchUrlBtn'),
    uploadSection: document.getElementById('uploadSection'),
    
    // Tabs (for preview)
    uploadTab: document.getElementById('uploadTab'),
    
    // Config
    huntSection: document.getElementById('configSection'),
    configSection: document.getElementById('configSection'), // Keep both for safety
    parallelWorkers: document.getElementById('parallelWorkers'),
    providerSelect: document.getElementById('providerSelect'),  // NEW
    modelSelect: document.getElementById('modelSelect'),
    // independentJudge removed (now mandatory)
    startHuntBtn: document.getElementById('startHuntBtn'),
    
    // Preview
    previewTabs: document.getElementById('previewTabs'),
    promptPreview: document.getElementById('promptPreview'),
    referencePreview: document.getElementById('referencePreview'),
    modelrefPreview: document.getElementById('modelrefPreview'),
    judgePreview: document.getElementById('judgePreview'),
    // Markdown textareas (new split view editors)
    promptMarkdown: document.getElementById('promptMarkdown'),
    responseMarkdown: document.getElementById('responseMarkdown'),
    judgeMarkdown: document.getElementById('judgeMarkdown'),
    judgeReferenceBtn: document.getElementById('judgeReferenceBtn'),
    saveResponseBtn: document.getElementById('saveReponseBtn'),  // Save Response button
    judgeBeforeHuntBtn: document.getElementById('judgeBeforeHuntBtn'),  // Judge button next to Start Hunt
    referenceJudgeResult: document.getElementById('referenceJudgeResult'),
    metadataToggleBtn: document.getElementById('metadataToggleBtn'),
    
    // New editable elements
    metadataSidebar: document.getElementById('metadataSidebar'),
    metadataCard: document.getElementById('metadataCard'), // Keep for backward compatibility
    metadataGrid: document.getElementById('metadataGrid'),
    promptLengthWarning: document.getElementById('promptLengthWarning'),
    promptLengthInfo: document.getElementById('promptLengthInfo'),
    savePromptBtn: document.getElementById('savePromptBtn'),
    saveModelRefBtn: document.getElementById('saveModelRefBtn'),
    saveJudgeBtn: document.getElementById('saveJudgeBtn'),
    saveAllBtn: document.getElementById('saveAllBtn'),
    jsonPreviewContent: document.getElementById('jsonPreviewContent'),
    jsonPreviewStatus: document.getElementById('jsonPreviewStatus'),
    
    // Progress
    progressSection: document.getElementById('progressSection'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    progressPercent: document.getElementById('progressPercent'),
    breaksIndicator: document.getElementById('breaksIndicator'),
    resultsTableBody: document.getElementById('resultsTableBody'),
    huntStatus: document.getElementById('huntStatus'),
    statusText: document.getElementById('statusText'),
    
    // Results
    resultsSection: document.getElementById('resultsSection'),
    breakingResults: document.getElementById('breakingResults'),
    breakingResultsCard: document.getElementById('breakingResultsCard'),
    breakingResultsCardHeader: document.getElementById('breakingResultsCardHeader'),
    breakingResultsCardBody: document.getElementById('breakingResultsCardBody'),
    breakingResultsCollapsedSummary: document.getElementById('breakingResultsCollapsedSummary'),
    breakingResultsCollapseBtn: document.getElementById('breakingResultsCollapseBtn'),
    noBreaksMessage: document.getElementById('noBreaksMessage'),
    saveDriveBtn: document.getElementById('saveDriveBtn'),
    saveDriveContainer: document.getElementById('saveDriveContainer'),
    
    // Summary
    summarySection: document.getElementById('summarySection'),
    
    // Multi-Turn Section
    multiTurnSection: document.getElementById('multiTurnSection'),
    
    // Selection Section (NEW)
    selectionSection: document.getElementById('selectionSection'),
    selectionGrid: document.getElementById('selectionGrid'),
    selectionCount: document.getElementById('selectionCount'),
    confirmSelectionBtn: document.getElementById('confirmSelectionBtn'),
    
    // Reveal Button - now at bottom
    revealLLMBtn: document.getElementById('revealLLMBtnBottom'),  // Bottom button
    reviewProgressText: document.getElementById('reviewProgressText'),
    reviewInstructions: document.getElementById('reviewInstructions'),
    reviewProgressContainer: document.getElementById('reviewProgressContainer'),
    changeSelectionBtn: document.getElementById('changeSelectionBtn'),
    bottomInstructions: document.getElementById('bottomInstructions'),
    
    // Blind Judging Modal
    blindJudgeModal: document.getElementById('blindJudgeModal'),
    judgeHuntId: document.getElementById('judgeHuntId'),
    judgeResponseText: document.getElementById('judgeResponseText'),
    humanJudgePass: document.getElementById('humanJudgePass'),
    humanJudgeFail: document.getElementById('humanJudgeFail'),
    humanJudgeSkip: document.getElementById('humanJudgeSkip'),
    llmJudgeReveal: document.getElementById('llmJudgeReveal'),
    humanJudgeResult: document.getElementById('humanJudgeResult'),
    llmJudgeResult: document.getElementById('llmJudgeResult'),
    judgeMatch: document.getElementById('judgeMatch'),
    nextHuntBtn: document.getElementById('nextHuntBtn'),
    
    toastContainer: document.getElementById('toastContainer'),
    
    // Response Slide-out Panel
    responseSlideout: document.getElementById('responseSlideout'),
    responseSlideoutBackdrop: document.getElementById('responseSlideoutBackdrop'),
    slideoutTitle: document.getElementById('slideoutTitle'),
    slideoutModel: document.getElementById('slideoutModel'),
    slideoutStatus: document.getElementById('slideoutStatus'),
    slideoutScore: document.getElementById('slideoutScore'),
    slideoutResponseText: document.getElementById('slideoutResponseText'),
    slideoutCloseBtn: document.getElementById('slideoutCloseBtn')
};
