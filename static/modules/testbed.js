/**
 * testbed.js — barrel re-export facade for the Multi-Tab Response Testbed (v3).
 *
 * Implementation now lives in `./testbed/*.js`. This file preserves the original
 * import path and export surface so existing consumers work unchanged.
 */

export { validateJudgeOutputFormat } from './testbed/validate.js';
export { showTestbed, hideTestbed } from './testbed/render-chrome.js';
export { showNotebookPreview, goBackToNotebook } from './testbed/notebook-preview.js';
export { syncActiveRunToNotebook, resetTestbed, enableNavTestbedButton } from './testbed/lifecycle.js';
export { renderPriorConversationBanner } from './testbed/prior-banner.js';
export { initTestbed } from './testbed/init.js';
