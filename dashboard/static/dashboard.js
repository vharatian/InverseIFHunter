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
let weekdayChart = null;
let modelBreakChart = null;
let modelUsageChart = null;
let refreshInterval = null;
let fullRefreshInterval = null;
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
            loadWeekdayActivity();
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
    document.getElementById('avgLatency').textContent = data.avg_latency_ms ? 
        `${(data.avg_latency_ms / 1000).toFixed(1)}s` : '--';
}

async function loadRealtimeStats() {
    try {
        const response = await fetch(`${API_BASE}/api/realtime`);
        const data = await response.json();
        
        document.getElementById('rtActiveSessions').textContent = data.active_sessions || 0;
        document.getElementById('rtHuntsInProgress').textContent = data.hunts_in_progress || 0;
        document.getElementById('rtRecentBreaks').textContent = data.recent_breaks || 0;
        document.getElementById('activeTrainers').textContent = data.active_trainers || 0;
    } catch (error) {
        console.error('Error loading realtime stats:', error);
    }
}

async function loadTimeline() {
    const data = await fetchAPI('timeline');
    if (!data || !data.timestamps || data.timestamps.length === 0) {
        // Show empty state message
        const container = document.getElementById('timelineChart').parentElement;
        const canvas = document.getElementById('timelineChart');
        if (timelineChart) {
            timelineChart.destroy();
            timelineChart = null;
        }
        // Create or update empty state message
        let emptyMsg = container.querySelector('.empty-state');
        if (!emptyMsg) {
            emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-state';
            emptyMsg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:14px;';
            container.appendChild(emptyMsg);
        }
        emptyMsg.textContent = 'No activity data for this time period';
        canvas.style.display = 'none';
        return;
    }
    
    // Restore canvas if it was hidden
    const canvas = document.getElementById('timelineChart');
    canvas.style.display = 'block';
    const emptyMsg = canvas.parentElement.querySelector('.empty-state');
    if (emptyMsg) emptyMsg.remove();
    
    const ctx = canvas.getContext('2d');
    
    if (timelineChart) {
        timelineChart.destroy();
    }
    
    // Format labels to show date when day changes
    let lastDate = null;
    const labels = data.timestamps.map(t => {
        const d = new Date(t);
        const dOpts = { month: 'short', day: 'numeric' };
        const tOpts = { hour: '2-digit', minute: '2-digit' };
        if (_tzMode === 'utc') { dOpts.timeZone = 'UTC'; tOpts.timeZone = 'UTC'; }
        const dateStr = d.toLocaleDateString([], dOpts);
        const timeStr = d.toLocaleTimeString([], tOpts);
        
        if (lastDate !== dateStr) {
            lastDate = dateStr;
            return `${dateStr}\n${timeStr}`;
        }
        return timeStr;
    });
    
    // Use stacked bar chart - much cleaner for time-bucketed activity data
    timelineChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Breaks',
                    data: data.breaks,
                    backgroundColor: '#ef4444',
                    borderRadius: 2,
                    stack: 'activity'
                },
                {
                    label: 'Hunts',
                    data: data.hunts,
                    backgroundColor: '#10b981',
                    borderRadius: 2,
                    stack: 'activity'
                },
                {
                    label: 'Sessions',
                    data: data.sessions || data.hunts.map(() => 0),
                    backgroundColor: '#6366f1',
                    borderRadius: 2,
                    stack: 'activity'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { 
                        color: '#94a3b8',
                        usePointStyle: true,
                        pointStyle: 'rectRounded',
                        padding: 15
                    }
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleColor: '#f8fafc',
                    bodyColor: '#cbd5e1',
                    borderColor: '#334155',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        title: function(tooltipItems) {
                            const idx = tooltipItems[0].dataIndex;
                            const ts = data.timestamps[idx];
                            return fmtDateTime(ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { 
                        color: '#94a3b8',
                        maxRotation: 45,
                        minRotation: 0,
                        font: { size: 10 }
                    },
                    grid: { 
                        display: false
                    }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { 
                        color: '#94a3b8',
                        stepSize: 5
                    },
                    grid: { 
                        color: '#334155',
                        drawBorder: false
                    },
                    title: {
                        display: true,
                        text: 'Count',
                        color: '#64748b',
                        font: { size: 11 }
                    }
                }
            }
        }
    });
}

async function loadWeekdayActivity() {
    const data = await fetchAPI('weekday_activity');
    if (!data || !data.days || !data.hunt_results) return;

    const canvas = document.getElementById('weekdayChart');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    let emptyMsg = wrap.querySelector('.empty-state');
    const total = data.hunt_results.reduce((a, b) => a + b, 0);
    if (total === 0) {
        if (weekdayChart) {
            weekdayChart.destroy();
            weekdayChart = null;
        }
        canvas.style.display = 'none';
        if (!emptyMsg) {
            emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-state';
            emptyMsg.style.cssText =
                'display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:14px;';
            wrap.appendChild(emptyMsg);
        }
        emptyMsg.textContent = 'No hunt results in this period';
        return;
    }
    canvas.style.display = 'block';
    if (emptyMsg) emptyMsg.remove();

    const ctx = canvas.getContext('2d');
    if (weekdayChart) weekdayChart.destroy();

    weekdayChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.days,
            datasets: [{
                label: 'Hunt results',
                data: data.hunt_results,
                backgroundColor: '#6366f1',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1e293b',
                    titleColor: '#f8fafc',
                    bodyColor: '#cbd5e1',
                    borderColor: '#334155',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    ticks: { color: '#94a3b8' },
                    grid: { display: false }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: '#94a3b8', precision: 0 },
                    grid: { color: '#334155' },
                    title: {
                        display: true,
                        text: 'Count',
                        color: '#64748b',
                        font: { size: 11 }
                    }
                }
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
    if (!data) return;
    
    const criteria = data.criteria || [];
    
    // Update chart
    const chartData = criteria.slice(0, 15);
    const chartDiv = document.getElementById('criteriaChart');

    if (chartDiv && window.Plotly) {
        try { Plotly.purge(chartDiv); } catch (_) {}
    }

    Plotly.newPlot(chartDiv, [{
        type: 'bar',
        orientation: 'h',
        y: chartData.map(c => c.criteria_id),
        x: chartData.map(c => c.fail_rate),
        marker: {
            color: chartData.map(c => c.difficulty_score),
            colorscale: [[0, '#f59e0b'], [1, '#ef4444']]
        },
        text: chartData.map(c => `${(c.fail_rate * 100).toFixed(1)}%`),
        textposition: 'outside'
    }], {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { t: 20, b: 40, l: 80, r: 60 },
        xaxis: {
            title: 'Fail Rate',
            tickformat: '.0%',
            tickfont: { color: '#94a3b8' },
            gridcolor: '#334155'
        },
        yaxis: {
            tickfont: { color: '#94a3b8' },
            autorange: 'reversed'
        }
    }, {responsive: true});
    
    // Update table
    const tbody = document.querySelector('#criteriaTable tbody');
    tbody.innerHTML = criteria.map(c => {
        const diff = Math.max(0, Math.min(1, Number(c.difficulty_score) || 0));
        return `
        <tr>
            <td>${escapeHtml(c.criteria_id || '')}</td>
            <td>${escapeHtml(String(c.total_evaluations ?? 0))}</td>
            <td>${escapeHtml(String(c.pass_count ?? 0))}</td>
            <td>${escapeHtml(String(c.fail_count ?? 0))}</td>
            <td>${((Number(c.fail_rate) || 0) * 100).toFixed(1)}%</td>
            <td>
                <div style="width: 100px; height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden;">
                    <div style="width: ${diff * 100}%; height: 100%; background: linear-gradient(90deg, #f59e0b, #ef4444);"></div>
                </div>
            </td>
        </tr>
        `;
    }).join('');
}

async function loadModels() {
    const data = await fetchAPI('models');
    if (!data || !data.models) return;
    
    const models = Object.entries(data.models).map(([name, stats]) => ({
        name: name.split('/').pop(),
        fullName: name,
        ...stats
    })).sort((a, b) => b.break_rate - a.break_rate);
    
    // Break rate chart
    const ctx1 = document.getElementById('modelBreakChart').getContext('2d');
    if (modelBreakChart) modelBreakChart.destroy();
    
    modelBreakChart = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels: models.map(m => m.name),
            datasets: [{
                label: 'Break Rate',
                data: models.map(m => m.break_rate * 100),
                backgroundColor: '#ef4444'
            }]
        },
        options: {
            responsive: true,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#94a3b8', callback: v => v + '%' },
                    grid: { color: '#334155' }
                },
                x: {
                    ticks: { color: '#94a3b8' },
                    grid: { display: false }
                }
            }
        }
    });
    
    // Usage chart
    const ctx2 = document.getElementById('modelUsageChart').getContext('2d');
    if (modelUsageChart) modelUsageChart.destroy();
    
    modelUsageChart = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: models.map(m => m.name),
            datasets: [{
                data: models.map(m => m.hunts),
                backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']
            }]
        },
        options: {
            responsive: true,
            animation: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#94a3b8' }
                }
            }
        }
    });
    
    // Table
    const tbody = document.querySelector('#modelTable tbody');
    tbody.innerHTML = models.map(m => `
        <tr>
            <td title="${escapeHtml(m.fullName || '')}">${escapeHtml(m.name || '')}</td>
            <td>${escapeHtml(String(m.hunts ?? 0))}</td>
            <td>${escapeHtml(String(m.breaks ?? 0))}</td>
            <td>${((Number(m.break_rate) || 0) * 100).toFixed(1)}%</td>
            <td>${m.avg_latency_ms ? (m.avg_latency_ms / 1000).toFixed(1) + 's' : '--'}</td>
            <td>${((Number(m.success_rate) || 0) * 100).toFixed(1)}%</td>
        </tr>
    `).join('');
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

document.addEventListener('DOMContentLoaded', () => {
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
});

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
