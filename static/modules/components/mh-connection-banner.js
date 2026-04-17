/**
 * <mh-connection-banner> — persistent offline / pending-sync banner.
 *
 * Subscribes to `onStatusChange` from offlineQueue.js and polls
 * `pendingCount()`. Renders inside a role=status + aria-live=polite region
 * so screen readers announce transitions. When online and queue is empty,
 * the banner is hidden via `hidden` attribute (display:none via CSS).
 *
 * Uses light DOM so the existing `.offline-banner*` styles in style.css
 * apply without duplication. No new CSS is shipped with this component.
 *
 * Usage: mount exactly once (typically early in app bootstrap):
 *     import './components/mh-connection-banner.js';
 *     // then in index.html (or JS):
 *     document.body.prepend(document.createElement('mh-connection-banner'));
 */

import { LitElement, html, nothing } from '../lit.js';
import { isOnline, onStatusChange, pendingCount } from '../offlineQueue.js';

export class MhConnectionBanner extends LitElement {
    static properties = {
        _online: { state: true },
        _pending: { state: true },
    };

    constructor() {
        super();
        this._online = isOnline();
        this._pending = 0;
        this._pollId = null;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        onStatusChange((online) => {
            this._online = online;
            this._refreshPending();
        });
        this._onPendingEvent = () => this._refreshPending();
        window.addEventListener('mh:queue-pending-changed', this._onPendingEvent);
        this._refreshPending();
        // Safety net poll in case an event is missed. 5s feels responsive
        // without being chatty — matches the existing reachability probe cadence.
        this._pollId = setInterval(() => this._refreshPending(), 5000);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._pollId) clearInterval(this._pollId);
        this._pollId = null;
        if (this._onPendingEvent) {
            window.removeEventListener('mh:queue-pending-changed', this._onPendingEvent);
            this._onPendingEvent = null;
        }
    }

    async _refreshPending() {
        try {
            this._pending = await pendingCount();
        } catch {
            this._pending = 0;
        }
    }

    render() {
        const visible = !this._online || this._pending > 0;
        const text = !this._online
            ? "You're offline — changes will sync when you reconnect"
            : this._pending > 0
                ? 'Reconnected — syncing queued changes'
                : '';
        const badge = this._pending > 0 ? `${this._pending} pending` : '';
        return html`
            <div
                id="offlineBanner"
                class=${`offline-banner ${visible ? '' : 'offline-banner--hidden'}`}
                role="status"
                aria-live="polite"
                ?hidden=${!visible}
            >
                <span class="offline-banner__icon" aria-hidden="true">${this._online ? '↻' : '⚡'}</span>
                <span class="offline-banner__text">${text || nothing}</span>
                <span class="offline-banner__badge" id="offlinePendingBadge">${badge || nothing}</span>
            </div>
        `;
    }
}

if (!customElements.get('mh-connection-banner')) {
    customElements.define('mh-connection-banner', MhConnectionBanner);
}
