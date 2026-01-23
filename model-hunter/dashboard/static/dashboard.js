/**
 * Model Hunter Dashboard JavaScript
 * 
 * Handles data fetching, chart rendering, and auto-refresh.
 */

// State
let timelineChart = null;
let modelChart = null;
let refreshInterval = null;

// Configuration
const REFRESH_INTERVAL = 30000; // 30 seconds
const BASE_PATH = window.BASE_PATH || '';
const API_BASE = BASE_PATH;

// ============== Initialization ==============

document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    refreshAll();
    startAutoRefresh();
    
    // Event listeners
    document.getElementById('timeRange').addEventListener('change', refreshAll);
    document.getElementById('eventFilter').addEventListener('change', loadEvents);
});

function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(refreshAll, REFRESH_INTERVAL);
}

// ============== Data Fetching ==============

async function fetchAPI(endpoint, params = {}) {
    // Build URL with base path
    const fullPath = API_BASE + endpoint;
    const url = new URL(fullPath, window.location.origin);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') {
            url.searchParams.set(k, v);
        }
    });
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error(`API Error (${endpoint}):`, error);
        return null;
    }
}

async function refreshAll() {
    const hours = parseInt(document.getElementById('timeRange').value);
    
    await Promise.all([
        loadOverview(hours),
        loadTimeline(hours),
        loadModelStats(hours),
        loadEvents(),
        loadSessions(),
        loadCosts(hours),
        loadDetailedHunts(hours),
        loadDetailedCalls(hours),
        loadBreaks(),
        loadFailures()
    ]);
    
    updateLastRefresh();
}

// ============== Overview ==============

async function loadOverview(hours) {
    const data = await fetchAPI('/api/overview', { hours });
    if (!data) return;
    
    document.getElementById('activeSessions').textContent = data.active_sessions || 0;
    document.getElementById('totalHunts').textContent = data.total_hunts || 0;
    document.getElementById('apiCalls').textContent = data.total_api_calls || 0;
    document.getElementById('avgLatency').textContent = data.avg_latency_ms 
        ? `${data.avg_latency_ms}ms` 
        : '--';
    document.getElementById('breaksFound').textContent = data.breaks_found || 0;
    document.getElementById('failedCalls').textContent = data.failed_api_calls || 0;
    
    // Show errors if any
    if (data.errors && data.errors.length > 0) {
        document.getElementById('errorsSection').style.display = 'block';
        renderErrors(data.errors);
    } else {
        document.getElementById('errorsSection').style.display = 'none';
    }
}

function renderErrors(errors) {
    const container = document.getElementById('errorList');
    container.innerHTML = errors.map(err => `
        <div class="error-item">
            <div class="error-message">${escapeHtml(err.error || 'Unknown error')}</div>
            <div class="error-meta">
                ${err.provider || ''} ${err.model ? `• ${truncateModel(err.model)}` : ''} 
                • ${formatTime(err.time)}
            </div>
        </div>
    `).join('');
}

// ============== Timeline Chart ==============

function initCharts() {
    // Timeline Chart
    const timelineCtx = document.getElementById('timelineChart').getContext('2d');
    timelineChart = new Chart(timelineCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'API Calls',
                    data: [],
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Hunts',
                    data: [],
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Errors',
                    data: [],
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    fill: true,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#94a3b8' }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#94a3b8', maxRotation: 45 },
                    grid: { color: 'rgba(71, 85, 105, 0.5)' }
                },
                y: {
                    ticks: { color: '#94a3b8' },
                    grid: { color: 'rgba(71, 85, 105, 0.5)' },
                    beginAtZero: true
                }
            }
        }
    });
    
    // Model Chart (Doughnut)
    const modelCtx = document.getElementById('modelChart').getContext('2d');
    modelChart = new Chart(modelCtx, {
        type: 'doughnut',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: [
                    '#3b82f6', '#22c55e', '#eab308', '#a855f7', 
                    '#ec4899', '#14b8a6', '#f97316', '#6366f1'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { 
                        color: '#94a3b8',
                        boxWidth: 12,
                        padding: 8
                    }
                }
            }
        }
    });
}

async function loadTimeline(hours) {
    const bucketMinutes = hours <= 6 ? 15 : hours <= 24 ? 60 : 180;
    const data = await fetchAPI('/api/timeline', { hours, bucket_minutes: bucketMinutes });
    if (!data) return;
    
    // Format timestamps
    const labels = (data.timestamps || []).map(ts => {
        const date = new Date(ts);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    
    timelineChart.data.labels = labels;
    timelineChart.data.datasets[0].data = data.api_calls || [];
    timelineChart.data.datasets[1].data = data.hunts || [];
    timelineChart.data.datasets[2].data = data.errors || [];
    timelineChart.update();
}

async function loadModelStats(hours) {
    const data = await fetchAPI('/api/models', { hours });
    if (!data) return;
    
    const models = Object.entries(data);
    
    // Update chart
    modelChart.data.labels = models.map(([model]) => truncateModel(model));
    modelChart.data.datasets[0].data = models.map(([, stats]) => stats.calls);
    modelChart.update();
    
    // Update table
    const tbody = document.querySelector('#modelTable tbody');
    if (models.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">No data available</td></tr>';
        return;
    }
    
    tbody.innerHTML = models.map(([model, stats]) => {
        const successClass = stats.success_rate >= 90 ? '' : 
                            stats.success_rate >= 70 ? 'warning' : 'danger';
        return `
            <tr>
                <td><span class="model-name" title="${escapeHtml(model)}">${truncateModel(model)}</span></td>
                <td>${stats.calls}</td>
                <td><span class="success-rate ${successClass}">${stats.success_rate}%</span></td>
                <td>${stats.avg_latency_ms}ms</td>
                <td>${stats.failures}</td>
            </tr>
        `;
    }).join('');
}

// ============== Events ==============

async function loadEvents() {
    const eventType = document.getElementById('eventFilter').value;
    const data = await fetchAPI('/api/events', { limit: 50, event_type: eventType || null });
    if (!data) return;
    
    const container = document.getElementById('eventList');
    if (!data.events || data.events.length === 0) {
        container.innerHTML = '<div class="loading">No events yet</div>';
        return;
    }
    
    container.innerHTML = data.events.map(event => {
        const { icon, typeClass, details } = formatEvent(event);
        return `
            <div class="event-item">
                <div class="event-icon">${icon}</div>
                <div class="event-content">
                    <div class="event-type ${typeClass}">${event.type.replace(/_/g, ' ')}</div>
                    <div class="event-details">${details}</div>
                    <div class="event-time">${formatTime(event.ts)}</div>
                </div>
            </div>
        `;
    }).join('');
}

function formatEvent(event) {
    const type = event.type;
    const data = event.data || {};
    
    let icon = '📄';
    let typeClass = '';
    let details = '';
    
    switch (type) {
        case 'session_created':
            icon = '🆕';
            typeClass = 'session';
            details = `Session ${data.session_id || ''} - ${data.notebook || 'Unknown notebook'}`;
            break;
        case 'hunt_start':
            icon = '🎯';
            typeClass = 'hunt';
            details = `Session ${data.session_id || ''} - ${data.workers || 0} workers`;
            break;
        case 'hunt_complete':
            icon = data.success ? '✅' : '⚠️';
            typeClass = 'hunt';
            details = `Session ${data.session_id || ''} - ${data.breaks_found || 0} breaks found`;
            break;
        case 'hunt_result':
            icon = data.is_breaking ? '💔' : '✓';
            typeClass = 'hunt';
            details = `Hunt #${data.hunt_id || ''} - Score: ${data.score ?? 'N/A'}`;
            break;
        case 'api_call_start':
            icon = '📡';
            typeClass = 'api';
            details = `${data.provider || ''} - ${truncateModel(data.model || '')}`;
            break;
        case 'api_call_end':
            icon = data.success ? '✓' : '❌';
            typeClass = data.success ? 'api' : 'error';
            details = data.success 
                ? `${data.provider || ''} - ${data.latency_ms || 0}ms`
                : `${data.provider || ''} - ${data.error || 'Error'}`;
            break;
        case 'judge_call':
            icon = '⚖️';
            typeClass = 'judge';
            details = `Score: ${data.score ?? 'N/A'} - ${data.latency_ms || 0}ms`;
            break;
        default:
            details = JSON.stringify(data).substring(0, 50);
    }
    
    return { icon, typeClass, details };
}

// ============== Sessions ==============

async function loadSessions() {
    const data = await fetchAPI('/api/sessions', { limit: 20 });
    if (!data) return;
    
    const container = document.getElementById('sessionList');
    if (!data.sessions || data.sessions.length === 0) {
        container.innerHTML = '<div class="loading">No sessions yet</div>';
        return;
    }
    
    container.innerHTML = data.sessions.map(session => `
        <div class="session-item">
            <div class="session-header">
                <span class="session-id">${session.session_id}</span>
                <span class="session-time">${formatTime(session.created_at)}</span>
            </div>
            <div class="session-notebook" title="${escapeHtml(session.notebook || '')}">${session.notebook || 'Unknown'}</div>
            <div class="session-stats">
                <span class="session-stat">🎯 ${session.hunts} hunts</span>
                <span class="session-stat">💔 ${session.breaks_found} breaks</span>
                <span class="session-stat">📡 ${session.api_calls} calls</span>
            </div>
        </div>
    `).join('');
}

// ============== Utilities ==============

function formatTime(isoString) {
    if (!isoString) return '--';
    try {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return date.toLocaleDateString();
    } catch {
        return '--';
    }
}

function truncateModel(model) {
    if (!model) return 'Unknown';
    // Extract just the model name part
    const parts = model.split('/');
    const name = parts[parts.length - 1];
    return name.length > 30 ? name.substring(0, 27) + '...' : name;
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function updateLastRefresh() {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = 
        `Last updated: ${now.toLocaleTimeString()}`;
}

// ============== Search ==============

let currentSearchQuery = '';

async function performSearch() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    
    currentSearchQuery = query;
    const hours = parseInt(document.getElementById('timeRange').value) * 7; // Search wider range
    
    const data = await fetchAPI('/api/search', { q: query, hours: Math.min(hours, 720), limit: 100 });
    if (!data) {
        alert('Search failed. Please try again.');
        return;
    }
    
    displaySearchResults(data);
}

function displaySearchResults(data) {
    const container = document.getElementById('searchResults');
    const listContainer = document.getElementById('searchResultsList');
    const querySpan = document.getElementById('searchQuery');
    
    querySpan.textContent = `"${data.query}" (${data.count} results)`;
    container.style.display = 'block';
    
    if (!data.results || data.results.length === 0) {
        listContainer.innerHTML = '<div class="loading">No results found</div>';
        return;
    }
    
    listContainer.innerHTML = data.results.map(result => {
        const type = result.type || 'unknown';
        const eventData = result.data || {};
        const ts = result.ts;
        
        let content = '';
        let meta = [];
        let preview = '';
        
        // Build content based on event type
        if (eventData.session_id) meta.push(`Session: ${eventData.session_id}`);
        if (eventData.notebook) meta.push(`Notebook: ${eventData.notebook}`);
        if (eventData.model) meta.push(`Model: ${truncateModel(eventData.model)}`);
        if (eventData.provider) meta.push(`Provider: ${eventData.provider}`);
        if (eventData.score !== null && eventData.score !== undefined) meta.push(`Score: ${eventData.score}`);
        if (eventData.latency_ms) meta.push(`Latency: ${eventData.latency_ms}ms`);
        if (eventData.is_breaking) meta.push('BREAKING');
        
        // Build preview from response/reasoning/error
        if (eventData.error) {
            preview = `Error: ${eventData.error}`;
        }
        if (eventData.response_preview) {
            preview += (preview ? '\n\n' : '') + `Response:\n${eventData.response_preview}`;
        }
        if (eventData.reasoning_preview) {
            preview += (preview ? '\n\n' : '') + `Reasoning:\n${eventData.reasoning_preview}`;
        }
        if (eventData.criteria && Object.keys(eventData.criteria).length > 0) {
            const criteriaStr = Object.entries(eventData.criteria)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            preview += (preview ? '\n\n' : '') + `Criteria: ${criteriaStr}`;
        }
        
        // Highlight search term in preview
        if (preview && currentSearchQuery) {
            const regex = new RegExp(`(${escapeRegex(currentSearchQuery)})`, 'gi');
            preview = escapeHtml(preview).replace(regex, '<span class="highlight">$1</span>');
        }
        
        return `
            <div class="search-result-item">
                <div class="search-result-header">
                    <span class="search-result-type ${type}">${type.replace(/_/g, ' ')}</span>
                    <span class="search-result-time">${formatTime(ts)}</span>
                </div>
                <div class="search-result-meta">${meta.join(' • ')}</div>
                ${preview ? `<div class="search-result-preview">${preview}</div>` : ''}
            </div>
        `;
    }).join('');
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResults').style.display = 'none';
    currentSearchQuery = '';
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============== Tabs ==============

function showTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(tabName)) {
            btn.classList.add('active');
        }
    });
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

// ============== Cost Tracking ==============

async function loadCosts(hours) {
    const data = await fetchAPI('/api/costs', { hours });
    if (!data) return;
    
    document.getElementById('totalCost').textContent = `$${data.total_cost.toFixed(4)}`;
    document.getElementById('totalTokensIn').textContent = data.total_tokens_in.toLocaleString();
    document.getElementById('totalTokensOut').textContent = data.total_tokens_out.toLocaleString();
    
    // Build cost table
    const tbody = document.querySelector('#costTable tbody');
    const rows = [];
    
    // Add provider rows
    for (const [provider, stats] of Object.entries(data.by_provider || {})) {
        rows.push({
            name: provider,
            type: 'provider',
            ...stats
        });
    }
    
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">No cost data yet</td></tr>';
        return;
    }
    
    tbody.innerHTML = rows.map(row => `
        <tr>
            <td><strong>${row.name}</strong></td>
            <td>${row.calls}</td>
            <td>${row.tokens_in.toLocaleString()}</td>
            <td>${row.tokens_out.toLocaleString()}</td>
            <td>$${row.cost.toFixed(4)}</td>
        </tr>
    `).join('');
}

// ============== Detailed Views ==============

async function loadDetailedHunts(hours) {
    const data = await fetchAPI('/api/hunts', { hours, limit: 50 });
    if (!data) return;
    
    const container = document.getElementById('huntsList');
    if (!data.hunts || data.hunts.length === 0) {
        container.innerHTML = '<div class="loading">No hunt results yet</div>';
        return;
    }
    
    container.innerHTML = data.hunts.map(hunt => {
        const scoreTag = hunt.is_breaking 
            ? '<span class="detail-tag breaking">BREAKING</span>'
            : `<span class="detail-tag pass">Score: ${hunt.score ?? 'N/A'}</span>`;
        
        const criteriaHtml = hunt.criteria ? Object.entries(hunt.criteria).map(([k, v]) => 
            `<span class="criteria-tag ${v.toLowerCase()}">${k}: ${v}</span>`
        ).join('') : '';
        
        return `
            <div class="detail-item">
                <div class="detail-header">
                    <span class="detail-title">Hunt #${hunt.hunt_id} - ${truncateModel(hunt.model)}</span>
                    <span class="detail-time">${formatTime(hunt.timestamp)}</span>
                </div>
                <div class="detail-meta">
                    <span>Session: ${hunt.session_id}</span>
                    ${scoreTag}
                </div>
                ${criteriaHtml ? `<div class="detail-criteria">${criteriaHtml}</div>` : ''}
                ${hunt.error ? `<div class="detail-preview" style="color: var(--accent-red);">Error: ${escapeHtml(hunt.error)}</div>` : ''}
                ${hunt.response_preview ? `<div class="detail-preview">${escapeHtml(hunt.response_preview)}</div>` : ''}
            </div>
        `;
    }).join('');
}

async function loadDetailedCalls(hours) {
    const data = await fetchAPI('/api/calls', { hours, limit: 100 });
    if (!data) return;
    
    const container = document.getElementById('callsList');
    if (!data.calls || data.calls.length === 0) {
        container.innerHTML = '<div class="loading">No API calls yet</div>';
        return;
    }
    
    container.innerHTML = data.calls.map(call => {
        const statusTag = call.success
            ? '<span class="detail-tag success">SUCCESS</span>'
            : '<span class="detail-tag error">FAILED</span>';
        
        return `
            <div class="detail-item">
                <div class="detail-header">
                    <span class="detail-title">${call.provider} - ${truncateModel(call.model)}</span>
                    <span class="detail-time">${formatTime(call.timestamp)}</span>
                </div>
                <div class="detail-meta">
                    ${statusTag}
                    <span>Latency: ${call.latency_ms}ms</span>
                    <span>Tokens: ${call.tokens_in}→${call.tokens_out}</span>
                    <span>Cost: $${call.cost.toFixed(6)}</span>
                    ${call.session_id ? `<span>Session: ${call.session_id}</span>` : ''}
                </div>
                ${call.error ? `<div class="detail-preview" style="color: var(--accent-red);">Error: ${escapeHtml(call.error)}</div>` : ''}
            </div>
        `;
    }).join('');
}

async function loadBreaks() {
    const data = await fetchAPI('/api/breaks', { hours: 168, limit: 50 });
    if (!data) return;
    
    const container = document.getElementById('breaksList');
    if (!data.breaks || data.breaks.length === 0) {
        container.innerHTML = '<div class="loading">No breaking responses found</div>';
        return;
    }
    
    container.innerHTML = data.breaks.map(brk => {
        const criteriaHtml = brk.criteria ? Object.entries(brk.criteria).map(([k, v]) => 
            `<span class="criteria-tag ${v.toLowerCase()}">${k}: ${v}</span>`
        ).join('') : '';
        
        return `
            <div class="detail-item">
                <div class="detail-header">
                    <span class="detail-title">Hunt #${brk.hunt_id} - ${truncateModel(brk.model)}</span>
                    <span class="detail-time">${formatTime(brk.timestamp)}</span>
                </div>
                <div class="detail-meta">
                    <span class="detail-tag breaking">SCORE: ${brk.score}</span>
                    <span>Session: ${brk.session_id}</span>
                </div>
                ${criteriaHtml ? `<div class="detail-criteria">${criteriaHtml}</div>` : ''}
                ${brk.response_preview ? `<div class="detail-preview">${escapeHtml(brk.response_preview)}</div>` : ''}
            </div>
        `;
    }).join('');
}

async function loadFailures() {
    const data = await fetchAPI('/api/failures', { hours: 168, limit: 50 });
    if (!data) return;
    
    const container = document.getElementById('failuresList');
    if (!data.failures || data.failures.length === 0) {
        container.innerHTML = '<div class="loading">No failures found</div>';
        return;
    }
    
    container.innerHTML = data.failures.map(fail => `
        <div class="detail-item">
            <div class="detail-header">
                <span class="detail-title">${fail.type.toUpperCase()} - ${truncateModel(fail.model || 'N/A')}</span>
                <span class="detail-time">${formatTime(fail.timestamp)}</span>
            </div>
            <div class="detail-meta">
                <span class="detail-tag error">FAILED</span>
                ${fail.provider ? `<span>Provider: ${fail.provider}</span>` : ''}
                ${fail.session_id ? `<span>Session: ${fail.session_id}</span>` : ''}
                ${fail.hunt_id ? `<span>Hunt: #${fail.hunt_id}</span>` : ''}
            </div>
            <div class="detail-preview" style="color: var(--accent-red);">${escapeHtml(fail.error || 'Unknown error')}</div>
        </div>
    `).join('');
}
