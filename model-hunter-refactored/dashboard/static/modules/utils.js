/**
 * Dashboard utility functions
 */
export function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

export function formatTime(ts) {
    if (!ts) return '-';
    try {
        const d = new Date(ts);
        const now = new Date();
        const diff = (now - d) / 1000;
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return d.toLocaleDateString();
    } catch {
        return String(ts).slice(0, 16);
    }
}

export function metricCard(label, value, deltaClass, deltaText) {
    return `<div class="metric-card">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
        ${deltaText ? `<div class="metric-delta ${deltaClass}">${deltaText}</div>` : ''}
    </div>`;
}

export function deltaClass(delta) {
    if (delta > 0) return 'positive';
    if (delta < 0) return 'negative';
    return 'neutral';
}

export function deltaText(delta) {
    if (delta == null) return '';
    return delta > 0 ? `+${delta} vs yesterday` : delta < 0 ? `${delta} vs yesterday` : 'same as yesterday';
}
