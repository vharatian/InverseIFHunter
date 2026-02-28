/**
 * Model Hunter Admin Dashboard - Entry Point
 *
 * Modular structure. Keyboard shortcuts: 1-8 sections, R refresh.
 */
import { state } from './modules/state.js';
import { api } from './modules/api.js';
import { initNavigation, navigateTo } from './modules/navigation.js';
import { REFRESH_INTERVAL_MS } from './modules/config.js';
import { loadCommandCenter } from './modules/sections/command-center.js';
import { loadTrainers, openTrainerDrilldown } from './modules/sections/trainers.js';
import { loadIntelligence } from './modules/sections/intelligence.js';
import { loadSessions, loadSessionReplay } from './modules/sections/sessions.js';
import { loadModels } from './modules/sections/models.js';
import { loadCosts } from './modules/sections/costs.js';
import { loadDataLab, selectExportProfile } from './modules/sections/datalab.js';
import { loadSystem } from './modules/sections/system.js';
import { addAdminAccess, removeAdminAccess, addTestAccount, removeTestAccount } from './modules/admin.js';

async function loadSection(section) {
    switch (section) {
        case 'command-center': await loadCommandCenter(); break;
        case 'trainers': await loadTrainers(); break;
        case 'intelligence': await loadIntelligence(); break;
        case 'sessions': await loadSessions(); break;
        case 'models': await loadModels(); break;
        case 'costs': await loadCosts(); break;
        case 'datalab': await loadDataLab(); break;
        case 'system': await loadSystem(); break;
    }
}

function initEventDelegation() {
    document.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-email]');
        if (tr) {
            openTrainerDrilldown(tr.dataset.email);
            return;
        }
        const sessionTr = e.target.closest('tr[data-session-id]');
        if (sessionTr) {
            loadSessionReplay(sessionTr.dataset.sessionId);
            return;
        }
        const card = e.target.closest('.export-card[data-profile-id]');
        if (card) {
            const name = card.querySelector('h4')?.textContent || card.dataset.profileId;
            selectExportProfile(card.dataset.profileId, name);
            return;
        }
        const revoke = e.target.closest('.btn-revoke');
        if (revoke) {
            removeAdminAccess(revoke.dataset.email);
            return;
        }
        const revokeTest = e.target.closest('.btn-revoke-test');
        if (revokeTest) {
            removeTestAccount(revokeTest.dataset.email);
            return;
        }
    });

    document.getElementById('drilldownClose')?.addEventListener('click', closeDrilldown);
    document.getElementById('drilldownBackdrop')?.addEventListener('click', closeDrilldown);

    document.getElementById('addAdminBtn')?.addEventListener('click', addAdminAccess);
    document.getElementById('newAdminEmail')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addAdminAccess(); }
    });
    document.getElementById('addTestBtn')?.addEventListener('click', addTestAccount);
    document.getElementById('newTestEmail')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTestAccount(); }
    });
}

function closeDrilldown() {
    document.getElementById('drilldownPanel')?.classList.remove('open');
    document.getElementById('drilldownBackdrop')?.classList.remove('open');
}

async function initDashboard() {
    const me = await api('me');
    if (me) {
        state.isSuperAdmin = me.is_super || false;
        state.currentEmail = me.email || '';
    }

    initNavigation(loadSection);
    initEventDelegation();

    state.refreshInterval = setInterval(() => loadSection(state.currentSection), REFRESH_INTERVAL_MS);

    await loadCommandCenter();
}

initDashboard();
