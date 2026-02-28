/**
 * Navigation and keyboard shortcuts
 */
import { state } from './state.js';
import { SECTIONS } from './config.js';

let loadSectionFn = null;

export function initNavigation(loadSection) {
    loadSectionFn = loadSection;

    document.querySelectorAll('#sidebarNav a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(link.dataset.section);
        });
    });

    document.addEventListener('keydown', handleKeyboard);
}

export function navigateTo(section) {
    if (!section || !loadSectionFn) return;
    state.currentSection = section;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('#sidebarNav a').forEach(a => a.classList.remove('active'));
    const el = document.getElementById(`section-${section}`);
    if (el) el.classList.add('active');
    const nav = document.querySelector(`[data-section="${section}"]`);
    if (nav) nav.classList.add('active');
    loadSectionFn(section);
}

function handleKeyboard(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const key = e.key.toLowerCase();
    if (key >= '1' && key <= '8') {
        const idx = parseInt(key, 10) - 1;
        if (SECTIONS[idx]) {
            e.preventDefault();
            navigateTo(SECTIONS[idx]);
        }
    } else if (key === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        loadSectionFn?.(state.currentSection);
    }
}
