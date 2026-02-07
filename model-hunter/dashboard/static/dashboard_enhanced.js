/**
 * Model Hunter Dashboard v2 - Enhanced JavaScript
 */

const API_BASE = window.BASE_PATH || '';
let timelineChart = null;
let modelBreakChart = null;
let modelUsageChart = null;
let refreshInterval = null;

// ============== Section Navigation ==============

function showSection(sectionId) {
    // Hide all sections
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    
    // Show selected section
    document.getElementById(`section-${sectionId}`).classList.add('active');
    event.target.classList.add('active');
    
    // Load section data
    loadSectionData(sectionId);
}

function showSubTab(tabId) {
    document.querySelectorAll('.sub-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
    
    document.getElementById(`subtab-${tabId}`).classList.add('active');
    event.target.classList.add('active');
    
    loadDetailTab(tabId);
}

function loadSectionData(sectionId) {
    switch(sectionId) {
        case 'overview':
            loadOverview();
            loadTimeline();
            loadHeatmap();
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

async function fetchAPI(endpoint) {
    try {
        const hours = document.getElementById('timeRange').value;
        const url = `${API_BASE}/api/${endpoint}${endpoint.includes('?') ? '&' : '?'}hours=${hours}`;
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error(`Error fetching ${endpoint}:`, error);
        return null;
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
        const dateStr = d.toLocaleDateString([], {month: 'short', day: 'numeric'});
        const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        
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
                            return new Date(ts).toLocaleString([], {
                                month: 'short', 
                                day: 'numeric',
                                hour: '2-digit', 
                                minute: '2-digit'
                            });
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

async function loadHeatmap() {
    const data = await fetchAPI('heatmap');
    if (!data) return;
    
    const heatmapData = [{
        z: data.data,
        x: data.hours,
        y: data.days,
        type: 'heatmap',
        colorscale: [
            [0, '#1e293b'],
            [0.5, '#6366f1'],
            [1, '#ef4444']
        ],
        showscale: true,
        colorbar: {
            tickfont: { color: '#94a3b8' }
        }
    }];
    
    const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { t: 20, b: 40, l: 50, r: 20 },
        xaxis: {
            title: 'Hour',
            tickfont: { color: '#94a3b8' },
            gridcolor: '#334155'
        },
        yaxis: {
            tickfont: { color: '#94a3b8' },
            gridcolor: '#334155'
        }
    };
    
    Plotly.newPlot('heatmapChart', heatmapData, layout, {responsive: true});
}

async function loadEvents() {
    const filter = document.getElementById('eventFilter').value;
    const endpoint = filter ? `events?event_type=${filter}&limit=50` : 'events?limit=50';
    const data = await fetchAPI(endpoint);
    if (!data) return;
    
    const container = document.getElementById('eventList');
    
    if (!data.events || data.events.length === 0) {
        container.innerHTML = '<div class="loading">No events found</div>';
        return;
    }
    
    container.innerHTML = data.events.map(event => {
        const icon = getEventIcon(event.type);
        const time = new Date(event.ts).toLocaleTimeString();
        const details = formatEventDetails(event);
        
        return `
            <div class="event-item">
                <span class="event-icon">${icon}</span>
                <div class="event-content">
                    <div class="event-type">${event.type.replace(/_/g, ' ')}</div>
                    <div class="event-details">${details}</div>
                </div>
                <span class="event-time">${time}</span>
            </div>
        `;
    }).join('');
}

function getEventIcon(type) {
    const icons = {
        'session_created': '📁',
        'hunt_start': '🎯',
        'hunt_complete': '✅',
        'hunt_result': '📊',
        'api_call_start': '📡',
        'api_call_end': '📥',
        'judge_call': '⚖️'
    };
    return icons[type] || '📌';
}

function formatEventDetails(event) {
    const data = event.data || {};
    switch(event.type) {
        case 'session_created':
            return `Session: ${data.session_id || 'N/A'}`;
        case 'hunt_result':
            return `Score: ${data.score ?? 'N/A'} | ${data.is_breaking ? '💔 BREAK' : '✓ Pass'} | ${data.model?.split('/').pop() || ''}`;
        case 'api_call_end':
            return `${data.provider} | ${data.latency_ms}ms | ${data.success ? '✓' : '✗'}`;
        default:
            return JSON.stringify(data);
    }
}

async function loadTrainers() {
    const data = await fetchAPI('trainers?limit=20');
    if (!data) return;
    
    const leaderboard = data.leaderboard || [];
    
    // Update podium
    if (leaderboard.length >= 1) {
        const p1 = leaderboard[0];
        document.querySelector('#podium1 .podium-name').textContent = p1.trainer_id;
        document.querySelector('#podium1 .podium-stat').textContent = `${p1.total_breaks} breaks`;
    }
    if (leaderboard.length >= 2) {
        const p2 = leaderboard[1];
        document.querySelector('#podium2 .podium-name').textContent = p2.trainer_id;
        document.querySelector('#podium2 .podium-stat').textContent = `${p2.total_breaks} breaks`;
    }
    if (leaderboard.length >= 3) {
        const p3 = leaderboard[2];
        document.querySelector('#podium3 .podium-name').textContent = p3.trainer_id;
        document.querySelector('#podium3 .podium-stat').textContent = `${p3.total_breaks} breaks`;
    }
    
    // Update table
    const tbody = document.querySelector('#trainerTable tbody');
    if (leaderboard.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="loading">No trainer data</td></tr>';
        return;
    }
    
    tbody.innerHTML = leaderboard.map(t => `
        <tr>
            <td>${t.rank}</td>
            <td>${t.trainer_id}</td>
            <td>${t.total_sessions}</td>
            <td>${t.total_hunts}</td>
            <td><strong>${t.total_breaks}</strong></td>
            <td>${(t.break_rate * 100).toFixed(1)}%</td>
            <td>${t.efficiency.toFixed(2)}</td>
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
    tbody.innerHTML = criteria.map(c => `
        <tr>
            <td>${c.criteria_id}</td>
            <td>${c.total_evaluations}</td>
            <td>${c.pass_count}</td>
            <td>${c.fail_count}</td>
            <td>${(c.fail_rate * 100).toFixed(1)}%</td>
            <td>
                <div style="width: 100px; height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden;">
                    <div style="width: ${c.difficulty_score * 100}%; height: 100%; background: linear-gradient(90deg, #f59e0b, #ef4444);"></div>
                </div>
            </td>
        </tr>
    `).join('');
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
            <td title="${m.fullName}">${m.name}</td>
            <td>${m.hunts}</td>
            <td>${m.breaks}</td>
            <td>${(m.break_rate * 100).toFixed(1)}%</td>
            <td>${m.avg_latency_ms ? (m.avg_latency_ms / 1000).toFixed(1) + 's' : '--'}</td>
            <td>${(m.success_rate * 100).toFixed(1)}%</td>
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
            name: `📦 ${provider}`,
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
            <td>${r.name}</td>
            <td>${r.calls}</td>
            <td>${r.tokens_in.toLocaleString()}</td>
            <td>${r.tokens_out.toLocaleString()}</td>
            <td>$${r.cost.toFixed(4)}</td>
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

// Content display - shows full content, collapsible if long
function formatContent(text) {
    if (!text) return { html: '<em>No response</em>', isLong: false };
    // Show full content always; mark as collapsible if very long
    const isLong = text.length > 500;
    return { html: text, full: text, isLong };
}

function escapeHtmlAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toggleCollapse(btn) {
    const content = btn.parentElement.querySelector('.detail-content');
    const isCollapsed = content.classList.contains('collapsed');
    
    if (isCollapsed) {
        content.classList.remove('collapsed');
        btn.textContent = '▲ Collapse';
    } else {
        content.classList.add('collapsed');
        btn.textContent = '▼ Show full';
    }
}

function formatDetailItem(item, type) {
    const time = new Date(item.timestamp).toLocaleString();
    
    switch(type) {
        case 'hunts':
            const huntsContent = formatContent(item.response_preview);
            return `
                <div class="detail-item ${item.is_breaking ? 'breaking' : ''}">
                    <div class="detail-header">
                        <span>${item.model?.split('/').pop() || 'Unknown'}</span>
                        <span class="detail-badge ${item.is_breaking ? 'fail' : 'success'}">
                            Score: ${item.score ?? 'N/A'} ${item.is_breaking ? '💔' : '✓'}
                        </span>
                    </div>
                    <div class="detail-content">${escapeHtmlAttr(huntsContent.html)}</div>
                    ${huntsContent.isLong ? '<button class="expand-btn" onclick="toggleCollapse(this)">▲ Collapse</button>' : ''}
                    <div class="detail-meta">
                        <span>🏷️ ${item.trainer_id || item.session_id}</span>
                        <span>📊 Criteria: ${Object.entries(item.criteria || {}).map(([k,v]) => `${k}:${v}`).join(', ') || 'N/A'}</span>
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
        
        case 'breaks':
            const breaksContent = formatContent(item.response_preview);
            return `
                <div class="detail-item breaking">
                    <div class="detail-header">
                        <span>💔 ${item.model?.split('/').pop()}</span>
                        <span class="detail-badge fail">BREAK</span>
                    </div>
                    <div class="detail-content">${escapeHtmlAttr(breaksContent.html)}</div>
                    ${breaksContent.isLong ? '<button class="expand-btn" onclick="toggleCollapse(this)">▲ Collapse</button>' : ''}
                    <div class="detail-meta">
                        <span>🏷️ ${item.trainer_id || item.session_id}</span>
                        <span>❌ Failed: ${Object.entries(item.criteria || {}).filter(([k,v]) => v === 'FAIL').map(([k]) => k).join(', ') || 'N/A'}</span>
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
        
        case 'calls':
            return `
                <div class="detail-item ${item.success ? '' : 'error'}">
                    <div class="detail-header">
                        <span>${item.provider} / ${item.model?.split('/').pop()}</span>
                        <span class="detail-badge ${item.success ? 'success' : 'fail'}">${item.success ? '✓' : '✗'}</span>
                    </div>
                    <div class="detail-meta">
                        <span>⏱️ ${item.latency_ms}ms</span>
                        <span>📥 ${item.tokens_in || 0} in</span>
                        <span>📤 ${item.tokens_out || 0} out</span>
                        <span>💰 $${item.cost?.toFixed(6) || '0'}</span>
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
        
        case 'failures':
            return `
                <div class="detail-item error">
                    <div class="detail-header">
                        <span>⚠️ ${item.type} error</span>
                        <span>${item.model?.split('/').pop() || ''}</span>
                    </div>
                    <div class="detail-content">${item.error || 'Unknown error'}</div>
                    <div class="detail-meta">
                        <span>🏷️ ${item.session_id || 'N/A'}</span>
                        <span class="detail-time">${time}</span>
                    </div>
                </div>
            `;
    }
}

// ============== Search ==============

async function performSearch() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    
    showSection('search');
    document.getElementById('searchResults').innerHTML = '<div class="loading">Searching...</div>';
    
    const data = await fetchAPI(`search?q=${encodeURIComponent(query)}&limit=100`);
    if (!data) return;
    
    const container = document.getElementById('searchResults');
    
    if (!data.results || data.results.length === 0) {
        container.innerHTML = '<div class="loading">No results found</div>';
        return;
    }
    
    container.innerHTML = `
        <p style="margin-bottom: 1rem;">Found ${data.count} results for "${query}"</p>
        ${data.results.map(r => `
            <div class="detail-item">
                <div class="detail-header">
                    <span>${r.type}</span>
                    <span class="detail-time">${new Date(r.ts).toLocaleString()}</span>
                </div>
                <div class="detail-content"><pre>${JSON.stringify(r.data, null, 2)}</pre></div>
            </div>
        `).join('')}
    `;
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    showSection('overview');
}

// ============== Refresh ==============

function refreshAll() {
    const activeSection = document.querySelector('.section.active');
    if (activeSection) {
        const sectionId = activeSection.id.replace('section-', '');
        loadSectionData(sectionId);
    }
    loadRealtimeStats();
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
}

// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    // Initial load
    loadSectionData('overview');
    loadRealtimeStats();
    
    // Auto-refresh realtime stats every 30 seconds (was 5s - too aggressive)
    refreshInterval = setInterval(() => {
        loadRealtimeStats();
    }, 30000);
    
    // Full dashboard refresh every 2 minutes
    setInterval(() => {
        refreshAll();
    }, 120000);
    
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
});
