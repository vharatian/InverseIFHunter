/**
 * <mh-turn-journey> — horizontal stepper showing completed / active / future turns.
 *
 * Ported from multiturn.js' `renderJourneyBar` as part of the Phase-2 Lit
 * migration. The element mounts into the existing `<nav #turnJourneyBar>`
 * slot on a light-DOM render so the pre-existing CSS (`.journey-node`,
 * `.journey-circle`, `.journey-label`, `.journey-connector`) continues to
 * apply unchanged.
 *
 * Rendering source of truth is the app's imperative `state` object; the
 * component subscribes to `stateBridge.subscribe('turns', ...)` and
 * re-renders on change. Legacy code should now call
 * `notify('turns')` instead of touching the bar DOM directly.
 *
 * Attributes:
 *   - hidden            hides the bar (used while outside the task view)
 *
 * Events:
 *   - mh-turn-activate  bubbles on click; detail = { turnNumber }
 */

import { LitElement, html, nothing } from '../lit.js';
import { state } from '../state.js';
import { subscribe } from '../stateBridge.js';
import { getTurnColor, dedupeTurnsByNumber } from '../utils.js';

export class MhTurnJourney extends LitElement {
    createRenderRoot() {
        return this;
    }

    constructor() {
        super();
        this._unsub = null;
    }

    connectedCallback() {
        super.connectedCallback();
        this._unsub = subscribe('turns', () => this.requestUpdate());
        // Add the aria-label here (in case the host element does not set it)
        // so the existing <nav> landmark advertises itself correctly.
        if (!this.hasAttribute('aria-label')) {
            this.setAttribute('aria-label', 'Turn progress');
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._unsub?.();
        this._unsub = null;
    }

    _steps() {
        const completed = dedupeTurnsByNumber(state.turns || [])
            .filter((t) => t.status !== 'breaking')
            .map((t) => ({
                turnNumber: t.turnNumber || t.turn_number,
                status: 'completed',
            }));
        return [
            ...completed,
            { turnNumber: state.currentTurn, status: 'active' },
            { turnNumber: state.currentTurn + 1, status: 'future' },
        ];
    }

    _activate(turnNumber) {
        this.dispatchEvent(new CustomEvent('mh-turn-activate', {
            detail: { turnNumber },
            bubbles: true,
            composed: true,
        }));
    }

    render() {
        const steps = this._steps();
        return html`${steps.map((step, idx) => html`
            ${idx > 0 ? html`
                <div class=${`journey-connector ${step.status === 'completed' || step.status === 'active' ? 'completed' : 'dashed'}`}></div>
            ` : nothing}
            <div
                class=${`journey-node ${step.status}`}
                role=${step.status !== 'future' ? 'button' : nothing}
                tabindex=${step.status !== 'future' ? '0' : nothing}
                aria-label=${step.status === 'active'
                    ? `Turn ${step.turnNumber} (current)`
                    : step.status === 'completed'
                        ? `Turn ${step.turnNumber} (completed)`
                        : 'Future turn'}
                @click=${step.status !== 'future' ? () => this._activate(step.turnNumber) : null}
                @keydown=${step.status !== 'future' ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this._activate(step.turnNumber);
                    }
                } : null}
            >
                <div
                    class="journey-circle"
                    style=${step.status !== 'future'
                        ? `background: ${getTurnColor(step.turnNumber)}`
                        : nothing}
                >${step.status === 'future' ? '?' : step.turnNumber}</div>
                <div class="journey-label">${
                    step.status === 'completed'
                        ? `Turn ${step.turnNumber}`
                        : step.status === 'active'
                            ? (state.isHunting ? 'Hunting' : 'Active')
                            : 'Next'
                }</div>
            </div>
        `)}`;
    }
}

if (!customElements.get('mh-turn-journey')) {
    customElements.define('mh-turn-journey', MhTurnJourney);
}
