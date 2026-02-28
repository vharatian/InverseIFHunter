/**
 * theme.js — Theme Toggling & Tab Management
 * 
 * Handles dark/light theme switching and tab initialization.
 */

import { elements } from './dom.js';

/**
 * Initialize theme from localStorage (default: dark).
 */
export function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

/**
 * Toggle between dark and light themes.
 */
export function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeIcon(next);
}

/**
 * Update the theme toggle button icon.
 * @param {string} theme - 'dark' or 'light'
 */
export function updateThemeIcon(theme) {
    elements.themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';
}

/**
 * Initialize tabs (kept for compatibility, no-op now).
 */
export function initTabs() {
    // No upload/url tabs anymore - only file upload
    // This function is kept for compatibility but does nothing now
}
