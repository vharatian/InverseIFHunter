/**
 * Quality Check — reusable tab bar component.
 * Creates a tab bar and panes; switching tabs shows/hides panes.
 */
import { escapeHtml } from './utils.js';

/**
 * Create a tabbed UI.
 * @param {Object} opts - { tabIds: string[], tabLabels: string[], defaultTab?: string }
 * @returns {{ container: HTMLElement, tabBar: HTMLElement, panes: Record<string, HTMLElement>, showTab: (id: string) => void }}
 */
export function createTabbedUI(opts) {
    const { tabIds, tabLabels, defaultTab } = opts;
    const container = document.createElement('div');
    container.className = 'qc-tabs-container';

    const tabBar = document.createElement('div');
    tabBar.className = 'qc-tab-bar';
    tabBar.setAttribute('role', 'tablist');

    const panesWrap = document.createElement('div');
    panesWrap.className = 'qc-tab-panes';

    const panes = {};
    tabIds.forEach((id, i) => {
        const btn = document.createElement('button');
        btn.className = `qc-tab-btn ${i === 0 ? 'active' : ''}`;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        btn.dataset.tab = id;
        btn.textContent = tabLabels[i] || id;
        tabBar.appendChild(btn);

        const pane = document.createElement('div');
        pane.className = `qc-tab-pane ${i === 0 ? 'active' : ''}`;
        pane.id = `qc-pane-${id}`;
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
        panes[id] = pane;
        panesWrap.appendChild(pane);
    });

    const showTab = (id) => {
        tabBar.querySelectorAll('.qc-tab-btn').forEach((b, i) => {
            const isActive = b.dataset.tab === id;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        Object.entries(panes).forEach(([paneId, pane]) => {
            const isActive = paneId === id;
            pane.classList.toggle('active', isActive);
            pane.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });
    };

    tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.qc-tab-btn');
        if (btn?.dataset?.tab) showTab(btn.dataset.tab);
    });

    container.appendChild(tabBar);
    container.appendChild(panesWrap);

    if (defaultTab && panes[defaultTab]) showTab(defaultTab);

    return { container, tabBar, panes, showTab };
}
