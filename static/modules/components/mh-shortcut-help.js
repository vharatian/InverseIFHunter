/**
 * <mh-shortcut-help> — keyboard-shortcut cheat sheet (opened via `?`).
 *
 * Single source of truth for global shortcuts. The registry is module-level
 * so other features can extend it (see `registerShortcut`). The overlay
 * itself listens for `?` and `Shift+/` at the window level, ignoring events
 * from input-like elements.
 *
 * Accessibility:
 *   - role=dialog, aria-modal=true
 *   - focus trap + restore on close
 *   - Escape closes
 *
 * Usage:
 *     import './components/mh-shortcut-help.js';
 *     // then once at app boot:
 *     document.body.appendChild(document.createElement('mh-shortcut-help'));
 *     // add shortcuts from any module:
 *     registerShortcut({ keys: 'Shift+H', label: 'Open hunt queue' });
 */

import { LitElement, html, css } from '../lit.js';
import { createFocusTrap } from '../focusTrap.js';

/** @type {Array<{ keys: string, label: string, group?: string }>} */
const _registry = [
    { keys: '?',      label: 'Show this help',           group: 'Global' },
    { keys: 'Esc',    label: 'Close modal / slideout',   group: 'Global' },
    { keys: 'Tab',    label: 'Next focusable element',   group: 'Global' },
    { keys: 'Shift+Tab', label: 'Previous focusable',    group: 'Global' },
];

/**
 * Register a shortcut so it shows up in the cheat sheet.
 * This module does NOT bind handlers — owners bind their own keydown listeners.
 */
export function registerShortcut(entry) {
    if (!entry || !entry.keys || !entry.label) return;
    _registry.push({ group: 'App', ...entry });
    window.dispatchEvent(new CustomEvent('mh:shortcuts-changed'));
}

export function getShortcuts() {
    return [..._registry];
}

export class MhShortcutHelp extends LitElement {
    static properties = {
        open: { type: Boolean, reflect: true },
    };

    static styles = css`
        :host {
            position: fixed;
            inset: 0;
            z-index: 10002;
            pointer-events: none;
        }
        :host([open]) {
            pointer-events: auto;
        }
        .overlay {
            position: absolute;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            backdrop-filter: blur(6px);
            display: none;
            align-items: center;
            justify-content: center;
            animation: mh-sh-fade 160ms ease-out;
        }
        :host([open]) .overlay { display: flex; }
        .panel {
            background: var(--bg-secondary, #1b1b1b);
            color: var(--text-primary, #fff);
            border: 1px solid var(--border, #2a2a2a);
            border-radius: 12px;
            max-width: min(560px, calc(100vw - 2rem));
            width: 100%;
            max-height: calc(100vh - 4rem);
            overflow: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
        }
        .panel header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1rem 1.25rem;
            border-bottom: 1px solid var(--border, #2a2a2a);
        }
        .panel header h2 {
            margin: 0;
            font-size: 1rem;
            letter-spacing: 0.02em;
        }
        .panel header button {
            appearance: none;
            background: transparent;
            color: inherit;
            border: 1px solid var(--border, #2a2a2a);
            border-radius: 6px;
            padding: 0.2rem 0.55rem;
            cursor: pointer;
            font-size: 0.8rem;
        }
        .group {
            padding: 0.75rem 1.25rem;
        }
        .group-title {
            font-size: 0.7rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--text-secondary, #9aa0a6);
            margin: 0 0 0.5rem;
        }
        dl {
            margin: 0;
            display: grid;
            grid-template-columns: minmax(120px, max-content) 1fr;
            gap: 0.35rem 1rem;
            align-items: baseline;
        }
        dt { margin: 0; }
        dd { margin: 0; color: var(--text-secondary, #cbd5e1); }
        kbd {
            display: inline-block;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 0.78rem;
            padding: 0.1rem 0.4rem;
            border: 1px solid var(--border, #2a2a2a);
            border-bottom-width: 2px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.04);
            color: var(--text-primary, #e5e7eb);
            min-width: 1.5em;
            text-align: center;
        }
        kbd + kbd { margin-left: 0.25rem; }
        @keyframes mh-sh-fade {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
            .overlay { animation: none; }
        }
    `;

    constructor() {
        super();
        this.open = false;
        this._trap = null;
        this._onKey = (e) => this._handleGlobalKey(e);
        this._onChange = () => this.requestUpdate();
    }

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('keydown', this._onKey, true);
        window.addEventListener('mh:shortcuts-changed', this._onChange);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('mh:shortcuts-changed', this._onChange);
        this._releaseTrap();
    }

    /** Public API for programmatic toggles. */
    toggle(force) {
        const next = typeof force === 'boolean' ? force : !this.open;
        this.open = next;
    }

    updated(changed) {
        if (!changed.has('open')) return;
        if (this.open) {
            // Defer so the rendered panel is focusable before trap initialises.
            queueMicrotask(() => {
                const panel = this.renderRoot.querySelector('.panel');
                if (panel) {
                    this._trap = createFocusTrap(panel, {
                        onEscape: () => { this.open = false; },
                    });
                }
            });
        } else {
            this._releaseTrap();
        }
    }

    _releaseTrap() {
        if (this._trap) {
            try { this._trap.release(); } catch { /* ignore */ }
            this._trap = null;
        }
    }

    _handleGlobalKey(e) {
        // `?` is commonly Shift+/ — accept both. Ignore while typing.
        if (e.key !== '?' && !(e.key === '/' && e.shiftKey)) return;
        if (this._isTyping(e.target)) return;
        e.preventDefault();
        this.toggle();
    }

    _isTyping(target) {
        if (!target) return false;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (target.isContentEditable) return true;
        return false;
    }

    _groups() {
        const map = new Map();
        for (const s of _registry) {
            const g = s.group || 'App';
            if (!map.has(g)) map.set(g, []);
            map.get(g).push(s);
        }
        return Array.from(map.entries());
    }

    _renderKeys(combo) {
        // 'Shift+H' → [Shift] [H] ;   '?' → [?]
        return combo.split('+').map((k) => html`<kbd>${k.trim()}</kbd>`);
    }

    render() {
        return html`
            <div
                class="overlay"
                role="dialog"
                aria-modal="true"
                aria-label="Keyboard shortcuts"
                @click=${(e) => { if (e.target.classList.contains('overlay')) this.open = false; }}
            >
                <section class="panel">
                    <header>
                        <h2>Keyboard shortcuts</h2>
                        <button type="button" @click=${() => { this.open = false; }}>Esc</button>
                    </header>
                    ${this._groups().map(([group, rows]) => html`
                        <div class="group">
                            <p class="group-title">${group}</p>
                            <dl>
                                ${rows.map((r) => html`
                                    <dt>${this._renderKeys(r.keys)}</dt>
                                    <dd>${r.label}</dd>
                                `)}
                            </dl>
                        </div>
                    `)}
                </section>
            </div>
        `;
    }
}

if (!customElements.get('mh-shortcut-help')) {
    customElements.define('mh-shortcut-help', MhShortcutHelp);
}
