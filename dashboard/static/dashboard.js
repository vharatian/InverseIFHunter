/**
 * Model Hunter Dashboard v2 - Enhanced JavaScript
 */

const API_BASE = window.BASE_PATH || '';

const TZ_KEY = 'mth-tz-mode';
let _tzMode = (() => { try { return localStorage.getItem(TZ_KEY) || 'local'; } catch (_) { return 'local'; } })();

function fmtDateTime(ts, opts = {}) {
    if (ts === null || ts === undefined || ts === '') return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '';
    const o = { ...opts };
    if (_tzMode === 'utc') o.timeZone = 'UTC';
    return d.toLocaleString([], o);
}
function fmtTime(ts) {
    if (ts === null || ts === undefined || ts === '') return '';
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '';
    const o = {};
    if (_tzMode === 'utc') o.timeZone = 'UTC';
    return d.toLocaleTimeString([], o);
}
function setTzMode(mode) {
    _tzMode = mode === 'utc' ? 'utc' : 'local';
    try { localStorage.setItem(TZ_KEY, _tzMode); } catch (_) {}
    const btn = document.getElementById('tzToggle');
    if (btn) {
        btn.textContent = _tzMode === 'utc' ? 'UTC' : 'Local';
        btn.setAttribute('aria-pressed', _tzMode === 'utc' ? 'true' : 'false');
    }
    if (typeof loadSectionData === 'function') {
        const active = document.querySelector('.tab-btn.active');
        if (active) loadSectionData(active.dataset.section);
    }
}
const TRAINER_EMAILS_STORAGE_KEY = 'dashboard_trainer_emails';
let timelineChart = null;
let latencyHistChart = null;
let modelBreakChart = null;
let modelUsageChart = null;
let refreshInterval = null;
let fullRefreshInterval = null;

// ============== Stats helpers ==============

/** Wilson score 95% CI for a proportion (binomial) — robust for small n. */
function wilsonCI(successes, total, z = 1.96) {
    const n = Number(total) || 0;
    if (n <= 0) return { p: 0, lo: 0, hi: 0 };
    const p = (Number(successes) || 0) / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
    return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function fmtMs(ms) {
    const v = Number(ms) || 0;
    if (v < 1000) return `${v.toFixed(0)}ms`;
    if (v < 10000) return `${(v / 1000).toFixed(2)}s`;
    return `${(v / 1000).toFixed(1)}s`;
}

/** Chart.js theme defaults derived from CSS tokens. */
function chartTheme() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    return {
        text:   get('--mth-text', '#ececec'),
        muted:  get('--mth-text-dim', '#8a8a96'),
        grid:   get('--mth-border-soft', '#1f1f26'),
        accent: get('--mth-primary', '#3b82f6'),
        hunt:   get('--mth-c-hunt', '#34d399'),
        brk:    get('--mth-c-break', '#f87171'),
        session:get('--mth-c-session', '#60a5fa'),
        err:    get('--mth-c-error', '#fbbf24'),
        surface:get('--mth-surface', '#1a1a20'),
        border: get('--mth-border', '#2a2a33'),
        palette: [
            get('--mth-c1', '#60a5fa'), get('--mth-c2', '#34d399'),
            get('--mth-c3', '#f472b6'), get('--mth-c4', '#fbbf24'),
            get('--mth-c5', '#a78bfa'), get('--mth-c6', '#22d3ee'),
            get('--mth-c7', '#f87171'), get('--mth-c8', '#84cc16'),
        ],
    };
}

function chartTooltip(theme) {
    return {
        backgroundColor: theme.surface,
        titleColor: theme.text,
        bodyColor: theme.text,
        borderColor: theme.border,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxPadding: 4,
        titleFont: { size: 11, weight: '700' },
        bodyFont: { size: 11 },
    };
}

function plotlyLayoutBase(theme, overrides = {}) {
    return Object.assign({
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { family: 'Inter, -apple-system, sans-serif', size: 11, color: theme.muted },
        margin: { t: 10, b: 36, l: 52, r: 16 },
        hoverlabel: { bgcolor: theme.surface, bordercolor: theme.border, font: { color: theme.text, size: 11 } },
        xaxis: { gridcolor: theme.grid, zerolinecolor: theme.grid, tickfont: { color: theme.muted } },
        yaxis: { gridcolor: theme.grid, zerolinecolor: theme.grid, tickfont: { color: theme.muted } },
    }, overrides);
}
// Tracks in-flight requests per endpoint so rapid filter/tab switches
// can cancel older fetches and avoid stale UI overwrites.
const _inflight = new Map();

function showSectionError(sectionId, message) {
    const el = document.getElementById(`section-${sectionId}`) || document.body;
    let banner = el.querySelector('.section-error-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'section-error-banner';
        banner.setAttribute('role', 'alert');
        el.prepend(banner);
    }
    banner.textContent = message;
    banner.style.display = 'block';
    setTimeout(() => { if (banner) banner.style.display = 'none'; }, 8000);
}

// ============== Section Navigation ==============

function showSection(sectionId, tabButtonEl) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
        b.setAttribute('tabindex', '-1');
    });

    const section = document.getElementById(`section-${sectionId}`);
    if (section) section.classList.add('active');
    const btn = tabButtonEl && tabButtonEl.classList.contains('tab-btn')
        ? tabButtonEl
        : document.querySelector(`.tab-btn[data-section="${sectionId}"]`);
    if (btn) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        btn.setAttribute('tabindex', '0');
    }

    loadSectionData(sectionId);
}

function _initTabKeyboardNav(rootSelector) {
    const tablist = document.querySelector(rootSelector);
    if (!tablist) return;
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    tablist.addEventListener('keydown', (e) => {
        const idx = tabs.indexOf(document.activeElement);
        if (idx < 0) return;
        let next = idx;
        if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        else return;
        e.preventDefault();
        tabs[next].focus();
        tabs[next].click();
    });
}

function showSubTab(tabId, subTabButtonEl) {
    document.querySelectorAll('.sub-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));

    document.getElementById(`subtab-${tabId}`).classList.add('active');
    if (subTabButtonEl && subTabButtonEl.classList.contains('sub-tab')) {
        subTabButtonEl.classList.add('active');
    }

    loadDetailTab(tabId);
}

function loadSectionData(sectionId) {
    switch(sectionId) {
        case 'overview':
            loadOverview();
            loadTimeline();
            loadActivityHeatmap();
            loadLatencyDistribution();
            loadEvents();
            break;
        case 'trainers':
            loadTrainers();
            break;
        case 'criteria':
            loadCriteria();
            break;
        case 'models':
            loadModels();
            break;
        case 'costs':
            loadCosts();
            break;
        case 'details':
            loadDetailTab('hunts');
            break;
    }
}

// ============== Data Loading ==============

function trainerEmailsQuery() {
    const el = document.getElementById('trainerEmailsFilter');
    const raw = el ? el.value : (localStorage.getItem(TRAINER_EMAILS_STORAGE_KEY) || '');
    const emails = String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    return emails.map(e => `&trainer_emails=${encodeURIComponent(e)}`).join('');
}

function onTrainerEmailsChange() {
    const el = document.getElementById('trainerEmailsFilter');
    if (el) localStorage.setItem(TRAINER_EMAILS_STORAGE_KEY, el.value.trim());
    refreshAll();
}

function _getCsrfCookie() {
    const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function _redirectToLogin() {
    try {
        const stagingPrefix = API_BASE.replace(/\/dashboard\/?$/, '');
        const adminBase = (stagingPrefix && stagingPrefix !== '/') ? `${stagingPrefix}/admin/` : '/admin/';
        window.location.href = adminBase;
    } catch (_) {}
}

async function fetchAPI(endpoint) {
    const hours = document.getElementById('timeRange').value;
    const te = trainerEmailsQuery();
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `${API_BASE}/api/${endpoint}${sep}hours=${hours}${te}`;

    const key = endpoint.split('?')[0];
    const prev = _inflight.get(key);
    if (prev) { try { prev.abort(); } catch (_) {} }
    const controller = new AbortController();
    _inflight.set(key, controller);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            credentials: 'include',
        });
        if (response.status === 401 || response.status === 503) {
            _redirectToLogin();
            throw new Error('Not authenticated');
        }
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${body ? ': ' + body.slice(0, 120) : ''}`);
        }
        const ct = response.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            throw new Error('Unexpected response type: ' + ct);
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') return null;
        console.error(`Error fetching ${endpoint}:`, error);
        const activeSection = document.querySelector('.section.active');
        if (activeSection) {
            const sectionId = activeSection.id.replace('section-', '');
            showSectionError(sectionId, `Failed to load ${key}: ${error.message}`);
        }
        return null;
    } finally {
        if (_inflight.get(key) === controller) _inflight.delete(key);
    }
}

async function loadOverview() {
    const data = await fetchAPI('overview');
    if (!data) return;
    
    document.getElementById('uniqueTrainers').textContent = data.unique_trainers || 0;
    document.getElementById('totalSessions').textContent = data.total_sessions || 0;
    document.getElementById('totalHunts').textContent = data.total_hunts || 0;
    document.getElementById('breaksFound').textContent = data.breaks_found || 0;
    document.getElementById('apiCalls').textContent = data.total_api_calls || 0;
    document.getElementById('avgLatency').textContent = data.avg_latency_ms
        ? fmtMs(data.avg_latency_ms) : '--';
}

async function loadRealtimeStats() {
    try {
        const response = await fetch(`${API_BASE}/api/realtime`);
        const data = await response.json();
        
        document.getElementById('rtActiveSessions').textContent = data.active_sessions || 0;
        document.getElementById('rtHuntsInProgress').textContent = data.hunts_in_progress || 0;
        document.getElementById('rtRecentBreaks').textContent = data.recent_breaks || 0;
        document.getElementById('activeTrainers').textContent = data.active_trainers || 0;
        renderActiveTrainersDropdown(data.active_trainer_emails || []);
    } catch (error) {
        console.error('Error loading realtime stats:', error);
    }
}

function renderActiveTrainersDropdown(emails) {
    const menu = document.getElementById('activeTrainersMenu');
    if (!menu) return;
    if (!emails.length) {
        menu.innerHTML = '<li class="realtime-dropdown-empty">No active trainers in the last 5 min</li>';
        return;
    }
    menu.innerHTML = emails.map((e) => {
        const safe = String(e).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        return `<li role="option" class="realtime-dropdown-item" title="${safe}">
            <span class="realtime-dropdown-dot"></span>
            <span class="realtime-dropdown-email">${safe}</span>
        </li>`;
    }).join('');
}

function initActiveTrainersDropdown() {
    const btn = document.getElementById('activeTrainersBtn');
    const menu = document.getElementById('activeTrainersMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !menu.classList.contains('hidden');
        menu.classList.toggle('hidden', open);
        btn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== btn) {
            menu.classList.add('hidden');
            btn.setAttribute('aria-expanded', 'false');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            menu.classList.add('hidden');
            btn.setAttribute('aria-expanded', 'false');
        }
    });
}

function _ensureEmptyState(wrap, msg) {
    let el = wrap.querySelector('.empty-state');
    if (!el) {
        el = document.createElement('div');
        el.className = 'empty-state';
        wrap.appendChild(el);
    }
    el.textContent = msg;
}

function _clearEmptyState(wrap) {
    const el = wrap.querySelector('.empty-state');
    if (el) el.remove();
}

async function loadTimeline() {
    const data = await fetchAPI('timeline');
    const canvas = document.getElementById('timelineChart');
    if (!canvas) return;
    const wrap = canvas.parentElement;

    if (!data || !data.timestamps || data.timestamps.length === 0) {
        if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
        canvas.style.display = 'none';
        _ensureEmptyState(wrap, 'No activity in this time window');
        return;
    }
    canvas.style.display = 'block';
    _clearEmptyState(wrap);

    const theme = chartTheme();
    const ctx = canvas.getContext('2d');
    if (timelineChart) timelineChart.destroy();

    let lastDate = null;
    const labels = data.timestamps.map(t => {
        const d = new Date(t);
        const dOpts = { month: 'short', day: 'numeric' };
        const tOpts = { hour: '2-digit', minute: '2-digit' };
        if (_tzMode === 'utc') { dOpts.timeZone = 'UTC'; tOpts.timeZone = 'UTC'; }
        const dateStr = d.toLocaleDateString([], dOpts);
        const timeStr = d.toLocaleTimeString([], tOpts);
        if (lastDate !== dateStr) { lastDate = dateStr; return `${dateStr}  ${timeStr}`; }
        return timeStr;
    });

    const sessions = data.sessions || data.hunts.map(() => 0);
    const totals = data.hunts.map((h, i) => (h || 0) + (data.breaks[i] || 0) + (sessions[i] || 0));
    // 3-bucket rolling mean for a smooth signal line.
    const win = 3;
    const rolling = totals.map((_, i) => {
        const lo = Math.max(0, i - Math.floor(win / 2));
        const hi = Math.min(totals.length, lo + win);
        const slice = totals.slice(lo, hi);
        return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
    });

    timelineChart = new Chart(ctx, {
        data: {
            labels,
            datasets: [
                { type: 'bar', label: 'Breaks',   data: data.breaks,  backgroundColor: theme.brk,    borderRadius: 3, stack: 'activity', barPercentage: 0.9, categoryPercentage: 0.85 },
                { type: 'bar', label: 'Hunts',    data: data.hunts,   backgroundColor: theme.hunt,   borderRadius: 3, stack: 'activity', barPercentage: 0.9, categoryPercentage: 0.85 },
                { type: 'bar', label: 'Sessions', data: sessions,     backgroundColor: theme.session,borderRadius: 3, stack: 'activity', barPercentage: 0.9, categoryPercentage: 0.85 },
                { type: 'line', label: 'Rolling mean (3)', data: rolling,
                  borderColor: theme.accent, backgroundColor: 'transparent', borderWidth: 2,
                  tension: 0.35, pointRadius: 0, pointHoverRadius: 3, borderDash: [4, 3] },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom', labels: { color: theme.muted, usePointStyle: true, pointStyle: 'rectRounded', padding: 12, font: { size: 11 } } },
                tooltip: {
                    ...chartTooltip(theme),
                    callbacks: {
                        title: (items) => fmtDateTime(data.timestamps[items[0].dataIndex], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    }
                }
            },
            scales: {
                x: { stacked: true, ticks: { color: theme.muted, maxRotation: 0, font: { size: 10 }, autoSkipPadding: 12 }, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { color: theme.muted, precision: 0 }, grid: { color: theme.grid, drawBorder: false } },
            }
        }
    });
}

async function loadActivityHeatmap() {
    const el = document.getElementById('heatmapChart');
    if (!el) return;
    const data = await fetchAPI('activity_heatmap');
    if (window.Plotly) { try { Plotly.purge(el); } catch (_) {} }
    if (!data || !data.grid || !data.total) {
        _ensureEmptyState(el, 'No hunt results in this period');
        return;
    }
    _clearEmptyState(el);
    const theme = chartTheme();
    // Bin hours into 3h buckets for a cuter, less noisy heatmap.
    const hourBuckets = ['0-3', '3-6', '6-9', '9-12', '12-15', '15-18', '18-21', '21-24'];
    const z = data.grid.map(row => {
        const out = new Array(hourBuckets.length).fill(0);
        for (let h = 0; h < 24; h++) out[Math.floor(h / 3)] += row[h] || 0;
        return out;
    });
    const trace = {
        type: 'heatmap',
        x: hourBuckets,
        y: data.days,
        z,
        colorscale: [
            [0,   'rgba(59,130,246,0.00)'],
            [0.2, 'rgba(59,130,246,0.18)'],
            [0.5, 'rgba(96,165,250,0.55)'],
            [0.8, 'rgba(167,139,250,0.85)'],
            [1,   'rgba(244,114,182,1.00)'],
        ],
        showscale: false,
        xgap: 2, ygap: 2,
        hovertemplate: '%{y} · %{x}h<br>%{z} hunt results<extra></extra>',
    };
    const layout = plotlyLayoutBase(theme, {
        margin: { t: 6, b: 30, l: 38, r: 6 },
        xaxis: { tickfont: { color: theme.muted, size: 10 }, showgrid: false, zeroline: false, fixedrange: true },
        yaxis: { tickfont: { color: theme.muted, size: 10 }, showgrid: false, zeroline: false, autorange: 'reversed', fixedrange: true },
    });
    const cfg = { displayModeBar: false, responsive: true };
    Plotly.newPlot(el, [trace], layout, cfg);
}

async function loadLatencyDistribution() {
    const canvas = document.getElementById('latencyHist');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const data = await fetchAPI('latency_distribution');
    const setPill = (id, ms) => { const el = document.getElementById(id); if (el) el.textContent = fmtMs(ms); };
    const setCount = (n) => { const el = document.getElementById('latencyCount'); if (el) el.textContent = n ? `${n.toLocaleString()} calls` : ''; };
    if (!data || !data.count) {
        if (latencyHistChart) { latencyHistChart.destroy(); latencyHistChart = null; }
        canvas.style.display = 'none';
        _ensureEmptyState(wrap, 'No API calls in this period');
        ['latP50','latP90','latP95','latP99'].forEach(id => setPill(id, 0));
        setCount(0);
        return;
    }
    canvas.style.display = 'block';
    _clearEmptyState(wrap);
    setPill('latP50', data.p50_ms);
    setPill('latP90', data.p90_ms);
    setPill('latP95', data.p95_ms);
    setPill('latP99', data.p99_ms);
    setCount(data.count);

    const theme = chartTheme();
    const ctx = canvas.getContext('2d');
    if (latencyHistChart) latencyHistChart.destroy();
    // Color bars by bucket position — cool for fast, warm for slow.
    const palette = [theme.hunt, theme.hunt, theme.session, theme.session, theme.accent, theme.palette[4], theme.err, theme.err, theme.brk];
    latencyHistChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.hist_labels,
            datasets: [{
                label: 'API calls',
                data: data.hist_counts,
                backgroundColor: data.hist_labels.map((_, i) => palette[i] || theme.accent),
                borderRadius: 4,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: {
                legend: { display: false },
                tooltip: { ...chartTooltip(theme),
                    callbacks: {
                        title: (i) => i[0].label,
                        label: (ctx) => {
                            const n = ctx.parsed.y;
                            const pct = data.count ? (100 * n / data.count).toFixed(1) : '0';
                            return `${n.toLocaleString()} calls · ${pct}%`;
                        }
                    }
                },
            },
            scales: {
                x: { ticks: { color: theme.muted, font: { size: 10 } }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: theme.muted, precision: 0 }, grid: { color: theme.grid } },
            }
        }
    });
}

async function loadEvents() {
    const filter = document.getElementById('eventFilter').value;
    const endpoint = filter ? `events?event_type=${filter}&limit=50` : 'events?limit=50';
    const data = await fetchAPI(endpoint);
    const container = document.getElementById('eventList');
    if (!container) return;

    if (!data) {
        // Request failed or was superseded. If another fetch is still in
        // flight it will update the UI; otherwise surface the failure so the
        // feed doesn't stay stuck on "Loading..." forever.
        if (_inflight.has('events')) return;
        container.innerHTML = '<div class="loading">Failed to load events. Retrying…</div>';
        return;
    }

    if (!data.events || data.events.length === 0) {
        container.innerHTML = '<div class="loading">No events found</div>';
        return;
    }
    
    try {
        container.innerHTML = data.events.map(event => {
            const marker = getEventTypeMarker(event.type);
            const time = escapeHtml(fmtTime(event.ts));
            const details = formatEventDetails(event);
            const d = event.data || {};
            const rawColab = event.colab_url || d.colab_url || d.url || '';
            const colabUrl = typeof rawColab === 'string' ? rawColab.trim() : '';
            const viewTask = colabUrl && /^https?:\/\//i.test(colabUrl)
                ? `<a class="event-view-task" href="${escapeHtml(colabUrl)}" target="_blank" rel="noopener noreferrer">View task</a>`
                : '';
            const typeSafe = escapeHtml(event.type || '');
            return `
                <div class="event-item">
                    <span class="event-type-marker" title="${typeSafe}">${escapeHtml(marker)}</span>
                    <div class="event-content">
                        <div class="event-type">${escapeHtml(String(event.type || '').replace(/_/g, ' '))}</div>
                        <div class="event-details">${details}</div>
                    </div>
                    <div class="event-actions">${viewTask}</div>
                    <span class="event-time">${time}</span>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Error rendering live events:', err);
        container.innerHTML = '<div class="loading">Failed to render events</div>';
    }
}

function getEventTypeMarker(type) {
    const abbrev = {
        session_created: 'SC',
        hunt_start: 'HS',
        hunt_complete: 'HC',
        hunt_result: 'HR',
        api_call_start: 'A+',
        api_call_end: 'A−',
        judge_call: 'JG'
    };
    const key = String(type || '');
    return abbrev[key] || (key ? key.slice(0, 2).toUpperCase() : '??');
}

function formatEventDetails(event) {
    const data = event.data || {};
    try {
        switch(event.type) {
            case 'session_created':
                return `Session: ${escapeHtml(data.session_id || 'N/A')}`;
            case 'hunt_result': {
                const model = typeof data.model === 'string' ? data.model.split('/').pop() : '';
                return `Score: ${escapeHtml(String(data.score ?? 'N/A'))} | ${data.is_breaking ? 'BREAK' : 'Pass'} | ${escapeHtml(model || '')}`;
            }
            case 'api_call_end':
                return `${escapeHtml(String(data.provider ?? ''))} | ${escapeHtml(String(data.latency_ms ?? ''))}ms | ${data.success ? 'OK' : 'Failed'}`;
            default:
                return escapeHtml(JSON.stringify(data));
        }
    } catch (_) {
        return '';
    }
}

async function loadTrainers() {
    const data = await fetchAPI('trainers?limit=20');
    if (!data) return;
    
    const leaderboard = data.leaderboard || [];

    // Always reset all podiums first to avoid stale names/stats.
    for (let i = 1; i <= 3; i++) {
        const name = document.querySelector(`#podium${i} .podium-name`);
        const stat = document.querySelector(`#podium${i} .podium-stat`);
        if (name) name.textContent = '--';
        if (stat) stat.textContent = '--';
    }
    leaderboard.slice(0, 3).forEach((p, idx) => {
        const n = idx + 1;
        const name = document.querySelector(`#podium${n} .podium-name`);
        const stat = document.querySelector(`#podium${n} .podium-stat`);
        if (name) name.textContent = p.trainer_id || '--';
        if (stat) stat.textContent = `${p.total_breaks ?? 0} breaks`;
    });
    
    // Update table
    const tbody = document.querySelector('#trainerTable tbody');
    if (leaderboard.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading">No trainer data</td></tr>';
        return;
    }
    
    tbody.innerHTML = leaderboard.map(t => `
        <tr>
            <td>${escapeHtml(String(t.rank ?? ''))}</td>
            <td>${escapeHtml(t.trainer_id || '')}</td>
            <td>${escapeHtml(String(t.total_sessions ?? 0))}</td>
            <td>${escapeHtml(String(t.total_hunts ?? 0))}</td>
            <td><strong>${escapeHtml(String(t.total_breaks ?? 0))}</strong></td>
            <td>${((Number(t.break_rate) || 0) * 100).toFixed(1)}%</td>
            <td>${(Number(t.efficiency) || 0).toFixed(2)}</td>
        </tr>
    `).join('');
}

async function loadCriteria() {
    const data = await fetchAPI('criteria');
    const chartDiv = document.getElementById('criteriaChart');
    if (chartDiv && window.Plotly) { try { Plotly.purge(chartDiv); } catch (_) {} }
    if (!data) return;
    const criteria = data.criteria || [];
    const tbody = document.querySelector('#criteriaTable tbody');

    if (criteria.length === 0) {
        if (chartDiv) _ensureEmptyState(chartDiv, 'No criteria evaluations in this period');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="loading">No data</td></tr>';
        return;
    }
    if (chartDiv) _clearEmptyState(chartDiv);

    const theme = chartTheme();
    // Top 15 by fail rate (already sorted by difficulty_score desc on server).
    const top = criteria.slice(0, 15).map(c => {
        const ci = wilsonCI(c.fail_count, c.total_evaluations);
        return { ...c, lo: ci.lo, hi: ci.hi };
    });
    // Pareto denominator: total fails across ALL criteria (not just top-15).
    const totalFails = criteria.reduce((s, c) => s + (c.fail_count || 0), 0) || 1;
    let cum = 0;
    const paretoPct = top.map(c => { cum += (c.fail_count || 0); return (cum / totalFails) * 100; });

    // Reverse for horizontal display (highest at top).
    const y = top.map(c => c.criteria_id);
    const xFail = top.map(c => (c.fail_rate || 0) * 100);
    const errLo = top.map((c, i) => xFail[i] - c.lo * 100);
    const errHi = top.map((c, i) => c.hi * 100 - xFail[i]);
    const n = top.map(c => c.total_evaluations || 0);

    const barTrace = {
        type: 'bar', orientation: 'h', x: xFail, y, name: 'Fail rate',
        marker: {
            color: top.map(c => c.difficulty_score || 0),
            colorscale: [[0, theme.palette[3]], [0.5, theme.err], [1, theme.brk]],
            showscale: false,
            line: { width: 0 },
        },
        error_x: { type: 'data', symmetric: false, array: errHi, arrayminus: errLo, color: theme.muted, thickness: 1.2, width: 4 },
        text: xFail.map((v, i) => `${v.toFixed(1)}%  (n=${n[i]})`),
        textposition: 'outside', textfont: { color: theme.text, size: 10 },
        hovertemplate: '<b>%{y}</b><br>Fail rate: %{x:.1f}%<br>95% CI: [%{customdata[0]:.1f}%, %{customdata[1]:.1f}%]<br>n = %{customdata[2]}<extra></extra>',
        customdata: top.map(c => [c.lo * 100, c.hi * 100, c.total_evaluations]),
    };
    const paretoTrace = {
        type: 'scatter', mode: 'lines+markers',
        x: paretoPct, y, xaxis: 'x2',
        name: 'Cumulative % of all failures',
        line: { color: theme.accent, width: 2, dash: 'dot' },
        marker: { color: theme.accent, size: 6 },
        hovertemplate: '<b>%{y}</b><br>Cumulative: %{x:.1f}%<extra></extra>',
    };
    const layout = plotlyLayoutBase(theme, {
        margin: { t: 10, b: 44, l: 110, r: 60 },
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: -0.18, font: { color: theme.muted, size: 10 }, bgcolor: 'transparent' },
        xaxis: { title: { text: 'Fail rate (%)', font: { color: theme.muted, size: 10 } },
                 gridcolor: theme.grid, tickfont: { color: theme.muted }, range: [0, 115] },
        xaxis2: { overlaying: 'x', side: 'top', range: [0, 105], showgrid: false, tickfont: { color: theme.accent, size: 9 }, ticksuffix: '%' },
        yaxis: { tickfont: { color: theme.muted }, autorange: 'reversed', automargin: true },
    });
    Plotly.newPlot(chartDiv, [barTrace, paretoTrace], layout, { responsive: true, displayModeBar: false });

    tbody.innerHTML = criteria.map(c => {
        const diff = Math.max(0, Math.min(1, Number(c.difficulty_score) || 0));
        const ci = wilsonCI(c.fail_count, c.total_evaluations);
        return `
        <tr>
            <td>${escapeHtml(c.criteria_id || '')}</td>
            <td>${escapeHtml(String(c.total_evaluations ?? 0))}</td>
            <td>${escapeHtml(String(c.pass_count ?? 0))}</td>
            <td>${escapeHtml(String(c.fail_count ?? 0))}</td>
            <td title="95% Wilson CI: ${(ci.lo*100).toFixed(1)}% – ${(ci.hi*100).toFixed(1)}%">
                ${((Number(c.fail_rate) || 0) * 100).toFixed(1)}%
                <span style="color:var(--text-muted); font-size:0.72rem;">
                    &nbsp;[${(ci.lo*100).toFixed(0)}–${(ci.hi*100).toFixed(0)}]
                </span>
            </td>
            <td>
                <span class="bar-inline">
                    <span class="bar-inline-track"><span class="bar-inline-fill" style="width:${diff*100}%"></span></span>
                </span>
            </td>
        </tr>`;
    }).join('');
}

async function loadModels() {
    const data = await fetchAPI('models');
    if (!data || !data.models) return;
    const theme = chartTheme();

    // Enrich with Wilson CI and sort by conservative (lower-bound) ranking.
    let models = Object.entries(data.models).map(([name, stats]) => {
        const ci = wilsonCI(stats.breaks, stats.hunts);
        return {
            name: name.split('/').pop(),
            fullName: name,
            ...stats,
            ci_lo: ci.lo, ci_hi: ci.hi,
        };
    });

    // Hide models with zero hunts from charts (they aren't meaningfully comparable).
    const chartable = models.filter(m => (m.hunts || 0) > 0);
    chartable.sort((a, b) => (b.ci_lo - a.ci_lo) || (b.break_rate - a.break_rate));
    // Top 10 for chart readability; table still shows everything.
    const top = chartable.slice(0, 10).reverse(); // reverse so best stays on top in horizontal bar

    const brkCanvas = document.getElementById('modelBreakChart');
    const brkCtx = brkCanvas.getContext('2d');
    if (modelBreakChart) modelBreakChart.destroy();
    if (top.length === 0) {
        _ensureEmptyState(brkCanvas.parentElement, 'No model data in this period');
    } else {
        _clearEmptyState(brkCanvas.parentElement);
        const xBR  = top.map(m => (m.break_rate || 0) * 100);
        const errL = top.map(m => (m.break_rate - m.ci_lo) * 100);
        const errH = top.map(m => (m.ci_hi - m.break_rate) * 100);
        modelBreakChart = new Chart(brkCtx, {
            type: 'bar',
            data: {
                labels: top.map(m => m.name),
                datasets: [{
                    label: 'Break rate',
                    data: xBR,
                    backgroundColor: top.map(m => (m.break_rate > 0.1 ? theme.brk : theme.palette[3])),
                    borderRadius: 4,
                    borderSkipped: false,
                    errorBars: { lo: errL, hi: errH }, // custom, used by plugin below
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { ...chartTooltip(theme),
                        callbacks: {
                            label: (c) => {
                                const m = top[c.dataIndex];
                                return [
                                    `Break rate: ${(m.break_rate*100).toFixed(1)}%`,
                                    `95% CI: [${(m.ci_lo*100).toFixed(1)}%, ${(m.ci_hi*100).toFixed(1)}%]`,
                                    `n = ${m.hunts} hunts, ${m.breaks} breaks`,
                                ];
                            }
                        }
                    },
                },
                scales: {
                    x: { beginAtZero: true, ticks: { color: theme.muted, callback: v => v + '%' }, grid: { color: theme.grid } },
                    y: { ticks: { color: theme.text, font: { size: 11 } }, grid: { display: false } },
                }
            },
            plugins: [{
                id: 'ciErrorBars',
                afterDatasetsDraw(chart) {
                    const ctx = chart.ctx;
                    const ds = chart.data.datasets[0];
                    const eb = ds.errorBars || {};
                    if (!eb.lo || !eb.hi) return;
                    ctx.save();
                    ctx.strokeStyle = theme.muted;
                    ctx.lineWidth = 1.25;
                    const meta = chart.getDatasetMeta(0);
                    meta.data.forEach((bar, i) => {
                        const val = ds.data[i];
                        const xLo = chart.scales.x.getPixelForValue(Math.max(0, val - eb.lo[i]));
                        const xHi = chart.scales.x.getPixelForValue(val + eb.hi[i]);
                        const y = bar.y;
                        const cap = 4;
                        ctx.beginPath();
                        ctx.moveTo(xLo, y); ctx.lineTo(xHi, y);
                        ctx.moveTo(xLo, y - cap); ctx.lineTo(xLo, y + cap);
                        ctx.moveTo(xHi, y - cap); ctx.lineTo(xHi, y + cap);
                        ctx.stroke();
                    });
                    ctx.restore();
                }
            }]
        });
    }

    // Usage share: horizontal bar (readable, ordered, doughnut-free).
    const usageCanvas = document.getElementById('modelUsageChart');
    const usageCtx = usageCanvas.getContext('2d');
    if (modelUsageChart) modelUsageChart.destroy();
    const byHunts = [...chartable].sort((a, b) => b.hunts - a.hunts).slice(0, 10).reverse();
    if (byHunts.length === 0) {
        _ensureEmptyState(usageCanvas.parentElement, 'No model usage yet');
    } else {
        _clearEmptyState(usageCanvas.parentElement);
        const totalHunts = byHunts.reduce((s, m) => s + (m.hunts || 0), 0) || 1;
        modelUsageChart = new Chart(usageCtx, {
            type: 'bar',
            data: {
                labels: byHunts.map(m => m.name),
                datasets: [{
                    label: 'Hunts',
                    data: byHunts.map(m => m.hunts),
                    backgroundColor: byHunts.map((_, i) => theme.palette[i % theme.palette.length]),
                    borderRadius: 4,
                    borderSkipped: false,
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { ...chartTooltip(theme),
                        callbacks: {
                            label: (c) => {
                                const m = byHunts[c.dataIndex];
                                const share = (100 * m.hunts / totalHunts).toFixed(1);
                                return `${m.hunts.toLocaleString()} hunts · ${share}% share`;
                            }
                        }
                    },
                },
                scales: {
                    x: { beginAtZero: true, ticks: { color: theme.muted, precision: 0 }, grid: { color: theme.grid } },
                    y: { ticks: { color: theme.text, font: { size: 11 } }, grid: { display: false } },
                }
            }
        });
    }

    // Table — keep all models, sorted by hunts desc.
    const tbody = document.querySelector('#modelTable tbody');
    models.sort((a, b) => (b.hunts || 0) - (a.hunts || 0));
    tbody.innerHTML = models.map(m => {
        const ciTxt = m.hunts > 0
            ? `<span style="color:var(--text-muted); font-size:0.72rem;">&nbsp;[${(m.ci_lo*100).toFixed(0)}–${(m.ci_hi*100).toFixed(0)}]</span>`
            : '';
        return `
        <tr>
            <td title="${escapeHtml(m.fullName || '')}">${escapeHtml(m.name || '')}</td>
            <td>${escapeHtml(String(m.hunts ?? 0))}</td>
            <td>${escapeHtml(String(m.breaks ?? 0))}</td>
            <td>${((Number(m.break_rate) || 0) * 100).toFixed(1)}%${ciTxt}</td>
            <td>${m.avg_latency_ms ? (m.avg_latency_ms / 1000).toFixed(1) + 's' : '--'}</td>
            <td>${((Number(m.success_rate) || 0) * 100).toFixed(1)}%</td>
        </tr>`;
    }).join('');
}

async function loadCosts() {
    const data = await fetchAPI('costs');
    if (!data) return;
    
    document.getElementById('totalCost').textContent = `$${data.total_cost.toFixed(4)}`;
    document.getElementById('tokensIn').textContent = data.total_tokens_in.toLocaleString();
    document.getElementById('tokensOut').textContent = data.total_tokens_out.toLocaleString();
    
    // Combine model and provider data
    const rows = [];
    
    for (const [provider, stats] of Object.entries(data.by_provider || {})) {
        rows.push({
            name: provider,
            ...stats,
            isProvider: true
        });
    }
    
    for (const [model, stats] of Object.entries(data.by_model || {})) {
        rows.push({
            name: `  └ ${model.split('/').pop()}`,
            ...stats,
            isProvider: false
        });
    }
    
    const tbody = document.querySelector('#costTable tbody');
    tbody.innerHTML = rows.map(r => `
        <tr style="${r.isProvider ? 'font-weight: bold;' : ''}">
            <td>${escapeHtml(r.name || '')}</td>
            <td>${escapeHtml(String(r.calls ?? 0))}</td>
            <td>${Number(r.tokens_in || 0).toLocaleString()}</td>
            <td>${Number(r.tokens_out || 0).toLocaleString()}</td>
            <td>$${(Number(r.cost) || 0).toFixed(4)}</td>
        </tr>
    `).join('');
}

async function loadDetailTab(tab) {
    const endpoints = {
        'hunts': 'hunts?limit=50',
        'breaks': 'breaks?limit=50',
        'calls': 'calls?limit=100',
        'failures': 'failures?limit=50'
    };
    
    const data = await fetchAPI(endpoints[tab]);
    if (!data) return;
    
    const container = document.getElementById(`${tab}List`);
    const items = data[tab] || data.hunts || data.breaks || data.calls || data.failures || [];
    
    if (items.length === 0) {
        container.innerHTML = '<div class="loading">No data</div>';
        return;
    }
    
    container.innerHTML = items.map(item => formatDetailItem(item, tab)).join('');
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toggleCollapse(btn) {
    const wrapper = btn.closest('.collapsible-wrapper');
    const content = wrapper.querySelector('.collapsible-content');
    const isCollapsed = content.classList.contains('collapsed');
    
    if (isCollapsed) {
        content.classList.remove('collapsed');
        btn.textContent = '▲ Collapse';
    } else {
        content.classList.add('collapsed');
        btn.textContent = '▼ Show full';
    }
}

function collapsibleBlock(label, text, defaultCollapsed = true) {
    if (!text) return '';
    const isLong = String(text).length > 300;
    const collapsed = isLong && defaultCollapsed ? 'collapsed' : '';
    const btnText = collapsed ? '▼ Show full' : '▲ Collapse';
    return `
        <div class="collapsible-wrapper">
            <div class="collapsible-label">${escapeHtml(label)}</div>
            <div class="collapsible-content detail-content ${collapsed}">${escapeHtml(text)}</div>
            ${isLong ? `<button type="button" class="expand-btn" data-action="toggleCollapse">${btnText}</button>` : ''}
        </div>
    `;
}

function formatCriteriaBadges(criteria) {
    if (!criteria || Object.keys(criteria).length === 0) return '<span class="criteria-empty">No criteria data</span>';
    return Object.entries(criteria).map(([k, v]) => {
        const cls = v === 'PASS' ? 'criteria-pass' : v === 'FAIL' ? 'criteria-fail' : 'criteria-missing';
        return `<span class="criteria-badge ${cls}">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`;
    }).join(' ');
}

function safeUrl(u) {
    if (!u) return '';
    return /^https?:\/\//i.test(u) ? escapeHtml(u) : '';
}

function formatDetailItem(item, type) {
    const time = escapeHtml(fmtDateTime(item.timestamp));
    const modelShort = escapeHtml(item.model?.split('/').pop() || 'Unknown');
    const trainerEmail = item.trainer_email
        ? `<span class="trainer-email">${escapeHtml(item.trainer_email)}</span>` : '';
    const colab = safeUrl(item.colab_url);
    const colabLink = colab
        ? `<a class="detail-colab-link" href="${colab}" target="_blank" rel="noopener noreferrer">View task</a>` : '';
    const idLabel = escapeHtml(item.trainer_id || item.session_id || '');

    switch(type) {
        case 'hunts':
            return `
                <div class="detail-item ${item.is_breaking ? 'breaking' : ''}">
                    <div class="detail-header">
                        <span>${modelShort}</span>
                        <span class="detail-badge ${item.is_breaking ? 'fail' : 'success'}">
                            Score: ${escapeHtml(String(item.score ?? 'N/A'))} ${item.is_breaking ? 'BREAK' : 'Pass'}
                        </span>
                    </div>
                    ${collapsibleBlock('Model response', item.response_preview, true)}
                    <div class="judge-section">
                        <div class="judge-header">Judge verdict</div>
                        <div class="criteria-list">${formatCriteriaBadges(item.criteria)}</div>
                        ${item.judge_explanation ? collapsibleBlock('Judge reasoning', item.judge_explanation, true) : ''}
                    </div>
                    <div class="detail-meta">
                        <span>${idLabel}</span>
                        ${trainerEmail}
                        ${colabLink}
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
        case 'breaks':
            return `
                <div class="detail-item breaking">
                    <div class="detail-header">
                        <span>${modelShort}</span>
                        <span class="detail-badge fail">BREAK</span>
                    </div>
                    ${collapsibleBlock('Model response', item.response_preview, true)}
                    <div class="judge-section">
                        <div class="judge-header">Judge verdict</div>
                        <div class="criteria-list">${formatCriteriaBadges(item.criteria)}</div>
                        ${item.judge_explanation ? collapsibleBlock('Judge reasoning', item.judge_explanation, true) : ''}
                    </div>
                    <div class="detail-meta">
                        <span>${idLabel}</span>
                        ${trainerEmail}
                        ${colabLink}
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
        case 'calls':
            return `
                <div class="detail-item ${item.success ? '' : 'error'}">
                    <div class="detail-header">
                        <span>${escapeHtml(item.provider || '')} / ${modelShort}</span>
                        <span class="detail-badge ${item.success ? 'success' : 'fail'}">${item.success ? 'OK' : 'Failed'}</span>
                    </div>
                    <div class="detail-meta">
                        <span>${escapeHtml(String(item.latency_ms ?? 0))}ms</span>
                        <span>${escapeHtml(String(item.tokens_in || 0))} in</span>
                        <span>${escapeHtml(String(item.tokens_out || 0))} out</span>
                        <span>$${(Number(item.cost) || 0).toFixed(6)}</span>
                        ${trainerEmail}
                        ${colabLink}
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
        case 'failures':
            return `
                <div class="detail-item error">
                    <div class="detail-header">
                        <span>${escapeHtml(item.type || '')} error</span>
                        <span>${modelShort}</span>
                    </div>
                    <div class="detail-content">${escapeHtml(item.error || 'Unknown error')}</div>
                    <div class="detail-meta">
                        <span>${escapeHtml(item.session_id || 'N/A')}</span>
                        ${trainerEmail}
                        ${colabLink}
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
    }
}

// ============== Search ==============

function overviewTabButton() {
    return document.querySelector('.tab-nav .tab-btn[data-section="overview"]');
}

async function performSearch() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    
    showSection('search', null);
    document.getElementById('searchResults').innerHTML = '<div class="loading">Searching...</div>';
    
    const data = await fetchAPI(`search?q=${encodeURIComponent(query)}&limit=100`);
    if (!data) return;
    
    const container = document.getElementById('searchResults');
    
    if (!data.results || data.results.length === 0) {
        container.innerHTML = '<div class="loading">No results found</div>';
        return;
    }
    
    container.replaceChildren();
    const header = document.createElement('p');
    header.style.marginBottom = '1rem';
    header.textContent = `Found ${data.count} results for "${query}"`;
    container.appendChild(header);
    for (const r of data.results) {
        const row = document.createElement('div');
        row.className = 'detail-item';
        const hdr = document.createElement('div');
        hdr.className = 'detail-header';
        const typeEl = document.createElement('span');
        typeEl.textContent = r.type || '';
        hdr.appendChild(typeEl);
        const timeEl = document.createElement('span');
        timeEl.className = 'detail-time';
        timeEl.textContent = fmtDateTime(r.ts);
        hdr.appendChild(timeEl);
        row.appendChild(hdr);
        const body = document.createElement('div');
        body.className = 'detail-content';
        const pre = document.createElement('pre');
        // textContent: JSON characters cannot break out of <pre>.
        pre.textContent = JSON.stringify(r.data, null, 2);
        body.appendChild(pre);
        row.appendChild(body);
        container.appendChild(row);
    }
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    showSection('overview', overviewTabButton());
}

// ============== Refresh ==============

function refreshAll() {
    const activeSection = document.querySelector('.section.active');
    if (activeSection) {
        const sectionId = activeSection.id.replace('section-', '');
        loadSectionData(sectionId);
    }
    loadRealtimeStats();
    document.getElementById('lastUpdate').textContent = fmtTime(new Date());
}

// ============== Initialize ==============

function _initDashboard() {
    const te = document.getElementById('trainerEmailsFilter');
    if (te) {
        const saved = localStorage.getItem(TRAINER_EMAILS_STORAGE_KEY);
        if (saved) te.value = saved;
        let filterTimer = null;
        const debouncedApply = () => {
            clearTimeout(filterTimer);
            filterTimer = setTimeout(onTrainerEmailsChange, 400);
        };
        te.addEventListener('input', debouncedApply);
        te.addEventListener('change', onTrainerEmailsChange);
        te.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(filterTimer);
                onTrainerEmailsChange();
            }
        });
    }
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                performSearch();
            }
        });
    }
    // Wire buttons/tabs that previously used inline handlers.
    document.getElementById('searchBtn')?.addEventListener('click', () => performSearch());
    document.getElementById('refreshBtn')?.addEventListener('click', () => refreshAll());
    document.getElementById('timeRange')?.addEventListener('change', () => refreshAll());
    document.getElementById('eventFilter')?.addEventListener('change', () => loadEvents());
    document.getElementById('clearSearchBtn')?.addEventListener('click', () => clearSearch());
    document.querySelectorAll('.tab-btn[data-section]').forEach((btn) => {
        btn.addEventListener('click', (e) => showSection(btn.dataset.section, btn));
    });
    document.querySelectorAll('.sub-tab[data-subtab]').forEach((btn) => {
        btn.addEventListener('click', (e) => showSubTab(btn.dataset.subtab, btn));
    });
    document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action="toggleCollapse"]');
        if (btn) toggleCollapse(btn);
    });
    _initTabKeyboardNav('.tab-nav');
    initActiveTrainersDropdown();

    const tzBtn = document.getElementById('tzToggle');
    if (tzBtn) {
        tzBtn.textContent = _tzMode === 'utc' ? 'UTC' : 'Local';
        tzBtn.setAttribute('aria-pressed', _tzMode === 'utc' ? 'true' : 'false');
        tzBtn.addEventListener('click', () => setTzMode(_tzMode === 'utc' ? 'local' : 'utc'));
    }

    loadSectionData('overview');
    loadRealtimeStats();

    setupLiveStream();

    refreshInterval = setInterval(() => {
        loadRealtimeStats();
    }, 60000);

    fullRefreshInterval = setInterval(() => {
        refreshAll();
    }, 300000);

    window.addEventListener('pagehide', () => {
        if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
        if (fullRefreshInterval) { clearInterval(fullRefreshInterval); fullRefreshInterval = null; }
        if (_liveStream && _liveStream.close) { try { _liveStream.close(); } catch (_) {} _liveStream = null; }
        _inflight.forEach(c => { try { c.abort(); } catch (_) {} });
        _inflight.clear();
    });

    document.getElementById('lastUpdate').textContent = fmtTime(new Date());
}

// dashboard.js is injected dynamically at the bottom of index.html, so it
// may run AFTER DOMContentLoaded has already fired. In that case attaching
// a DOMContentLoaded listener is a no-op and tab/button click handlers
// never get wired, leaving the UI unresponsive. Run init now if the DOM
// is already parsed; otherwise wait for the event.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initDashboard);
} else {
    _initDashboard();
}

// ============== Live stream (SSE) ==============

let _liveStream = null;
let _liveStreamBackoff = 1000;
const _sseDebounces = {};

function _sseDebounce(name, fn, ms = 500) {
    clearTimeout(_sseDebounces[name]);
    _sseDebounces[name] = setTimeout(fn, ms);
}

function setupLiveStream() {
    if (typeof EventSource === 'undefined') return;
    try {
        const url = `${API_BASE}/api/stream`;
        const es = new EventSource(url, { withCredentials: true });
        _liveStream = es;

        es.addEventListener('open', () => { _liveStreamBackoff = 1000; });

        es.addEventListener('telemetry', () => {
            _sseDebounce('realtime', () => loadRealtimeStats(), 250);
            _sseDebounce('active-section', () => refreshAll(), 1500);
        });
        es.addEventListener('config', () => {
            _sseDebounce('full', () => refreshAll(), 500);
        });
        es.addEventListener('team', () => {
            _sseDebounce('trainers', () => {
                if (document.getElementById('section-trainers')?.classList.contains('active')) {
                    loadTrainers();
                }
            }, 500);
        });
        es.addEventListener('db', () => {
            _sseDebounce('full', () => refreshAll(), 750);
        });

        es.onerror = () => {
            es.close();
            _liveStream = null;
            const delay = Math.min(_liveStreamBackoff, 30000);
            _liveStreamBackoff = Math.min(_liveStreamBackoff * 2, 60000);
            setTimeout(setupLiveStream, delay);
        };
    } catch (_) {}
}
