/**
 * <mh-skeleton> — loading placeholder that respects prefers-reduced-motion.
 *
 * Usage:
 *     <mh-skeleton variant="text" width="60%"></mh-skeleton>
 *     <mh-skeleton variant="rect" height="120px"></mh-skeleton>
 *     <mh-skeleton variant="circle" height="2rem" width="2rem"></mh-skeleton>
 *     <mh-skeleton variant="list" count="5"></mh-skeleton>
 *
 * Attributes:
 *   - variant: "text" | "rect" | "circle" | "list"   (default: "text")
 *   - count:   number of rows to render (variant="list" only; default 3)
 *   - width:   any CSS length (default 100%)
 *   - height:  any CSS length (default 1em for text, 100% for rect)
 *   - label:   aria-label override; default "Loading"
 */

import { LitElement, html, css, nothing } from '../lit.js';

export class MhSkeleton extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        count: { type: Number },
        width: { type: String },
        height: { type: String },
        label: { type: String },
    };

    static styles = css`
        :host {
            display: inline-block;
            width: var(--mh-skeleton-width, 100%);
            max-width: 100%;
            line-height: 1;
        }
        :host([variant="list"]) {
            display: block;
        }
        .bar {
            display: block;
            width: var(--mh-skeleton-width, 100%);
            height: var(--mh-skeleton-height, 1em);
            border-radius: 4px;
            background: linear-gradient(
                90deg,
                var(--bg-tertiary, #1c1c1c) 0%,
                var(--bg-hover, #272727) 50%,
                var(--bg-tertiary, #1c1c1c) 100%
            );
            background-size: 200% 100%;
            animation: mh-skel-shimmer 1.6s ease-in-out infinite;
        }
        :host([variant="circle"]) .bar {
            border-radius: 50%;
        }
        :host([variant="rect"]) .bar {
            border-radius: 8px;
        }
        .row + .row {
            margin-top: 0.5rem;
        }
        @keyframes mh-skel-shimmer {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
            .bar {
                animation: none;
                background: var(--bg-hover, #272727);
            }
        }
    `;

    constructor() {
        super();
        this.variant = 'text';
        this.count = 3;
        this.width = '';
        this.height = '';
        this.label = '';
    }

    _styleVars() {
        const vars = {};
        if (this.width) vars['--mh-skeleton-width'] = this.width;
        if (this.height) vars['--mh-skeleton-height'] = this.height;
        return Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join(';');
    }

    render() {
        const aria = this.label || 'Loading';
        const style = this._styleVars() || nothing;
        if (this.variant === 'list') {
            const rows = Array.from({ length: Math.max(1, this.count | 0) });
            return html`
                <div role="status" aria-live="polite" aria-label=${aria}>
                    ${rows.map((_, i) => html`
                        <div class="row"><span class="bar" style=${style || nothing}></span></div>
                    `)}
                </div>
            `;
        }
        return html`
            <span class="bar" role="status" aria-live="polite" aria-label=${aria} style=${style || nothing}></span>
        `;
    }
}

if (!customElements.get('mh-skeleton')) {
    customElements.define('mh-skeleton', MhSkeleton);
}
