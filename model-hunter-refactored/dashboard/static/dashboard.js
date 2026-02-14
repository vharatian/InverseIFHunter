/**
 * Model Hunter Admin Intelligence Dashboard - Frontend
 * 
 * Single-page app with sidebar navigation.
 * Fetches pre-computed analytics from backend cache.
 * Auto-refreshes every 60 seconds.
 */

// ============== State ==============
const state = {
    currentSection: 'command-center',
    refreshInterval: null,
    liveFeedSource: null,
    charts: {},
    selectedExportProfile: null,
    isSuperAdmin: false,
    currentEmail: '',
};

// ============== Navigation ==============
document.querySelectorAll('#sidebarNav a').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const section = link.dataset.section;
        navigateTo(section);
    });
});

function navigateTo(section) {
    state.currentSection = section;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('#sidebarNav a').forEach(a => a.classList.remove('active'));
    const el = document.getElementById(`section-${section}`);
    if (el) el.classList.add('active');
    const nav = document.querySelector(`[data-section="${section}"]`);
    if (nav) nav.classList.add('active');
    loadSection(section);
}

// ============== Data Loading ==============
async function api(endpoint) {
    const res = await fetch(`/api/${endpoint}`);
    if (res.status === 401) {
        window.location.reload();
        return null;
    }
    if (!res.ok) return null;
    return res.json();
}

async function loadSection(section) {
    switch (section) {
        case 'command-center': await loadCommandCenter(); break;
        case 'trainers': await loadTrainers(); break;
        case 'intelligence': await loadIntelligence(); break;
        case 'sessions': await loadSessions(); break;
        case 'models': await loadModels(); break;
        case 'costs': await loadCosts(); break;
        case 'datalab': await loadDataLab(); break;
        case 'system': await loadSystem(); break;
    }
}

// ============== Command Center ==============
async function loadCommandCenter() {
    const [overview, anomalies, online] = await Promise.all([
        api('overview'), api('anomalies'), api('online-trainers')
    ]);

    // Anomaly banner
    const banner = document.getElementById('anomalyBanner');
    if (anomalies && anomalies.length > 0) {
        const worst = anomalies.find(a => a.severity === 'critical') || anomalies[0];
        document.getElementById('anomalyText').textContent = worst.description;
        banner.className = `anomaly-banner visible ${worst.severity}`;
    } else {
        banner.className = 'anomaly-banner';
    }

    // Metrics
    if (overview) {
        const grid = document.getElementById('overviewMetrics');
        grid.innerHTML = [
            metricCard('Active Trainers', overview.active_trainers, '', overview.idle_trainers ? `+${overview.idle_trainers} idle` : ''),
            metricCard('Sessions Today', overview.sessions_today, deltaClass(overview.sessions_delta), deltaText(overview.sessions_delta)),
            metricCard('Hunts Today', overview.hunts_today, deltaClass(overview.hunts_delta), deltaText(overview.hunts_delta)),
            metricCard('Breaks Today', overview.breaks_today, deltaClass(overview.breaks_delta), deltaText(overview.breaks_delta)),
            metricCard('Cost Today', `$${overview.cost_today?.toFixed(2) || '0.00'}`, '', ''),
        ].join('');
    }

    // Active trainers
    if (online) {
        const list = document.getElementById('activeTrainersList');
        if (online.length === 0) {
            list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No trainers currently active</div>';
        } else {
            list.innerHTML = online.map(t => `
                <div class="feed-event">
                    <span class="status-dot ${t.status}"></span>
                    <span style="font-weight:600;">${esc(t.name)}</span>
                    <span style="color:var(--text-muted);font-size:0.75rem;">${esc(t.email)}</span>
                </div>
            `).join('');
        }
    }

    // Start live feed SSE
    startLiveFeed();
}

// ============== Trainers ==============
async function loadTrainers() {
    const [trainers, online] = await Promise.all([api('trainers'), api('online-trainers')]);

    // Online roster
    if (online) {
        const roster = document.getElementById('onlineRoster');
        if (online.length === 0) {
            roster.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No trainers online</div>';
        } else {
            roster.innerHTML = online.map(t => `
                <div style="display:inline-flex;align-items:center;gap:0.4rem;padding:0.3rem 0.7rem;margin:0.2rem;background:var(--bg-hover);border-radius:20px;font-size:0.8rem;">
                    <span class="status-dot ${t.status}"></span>${esc(t.name)}
                </div>
            `).join('');
        }
    }

    // Leaderboard
    if (trainers) {
        const tbody = document.getElementById('trainerTableBody');
        tbody.innerHTML = trainers.map((t, i) => `
            <tr onclick="openTrainerDrilldown('${esc(t.email)}')">
                <td>${i + 1}</td>
                <td><strong>${esc(t.name)}</strong></td>
                <td style="color:var(--text-muted);font-size:0.78rem;">${esc(t.email)}</td>
                <td><span class="status-dot ${t.status}"></span>${t.status}</td>
                <td>${t.active_hours}h</td>
                <td>${t.total_hunts}</td>
                <td>${t.total_breaks}</td>
                <td><strong>${t.breaks_per_hour}</strong></td>
                <td style="font-size:0.75rem;color:var(--text-muted);">${formatTime(t.last_seen)}</td>
            </tr>
        `).join('');
    }
}

async function openTrainerDrilldown(email) {
    const data = await api(`trainer/${encodeURIComponent(email)}`);
    if (!data) return;

    const panel = document.getElementById('drilldownPanel');
    const content = document.getElementById('drilldownContent');

    // Build calendar heatmap
    let calendarHtml = '';
    if (data.calendar) {
        calendarHtml = '<div class="calendar-heatmap">' + data.calendar.map(d => {
            const level = d.count === 0 ? '' : d.count <= 3 ? 'level-1' : d.count <= 8 ? 'level-2' : d.count <= 15 ? 'level-3' : 'level-4';
            return `<div class="calendar-cell ${level}" title="${d.date}: ${d.count} events"></div>`;
        }).join('') + '</div>';
    }

    content.innerHTML = `
        <h3 style="margin-bottom:0.5rem;">${esc(data.name)}</h3>
        <p style="color:var(--text-muted);font-size:0.82rem;margin-bottom:1rem;">${esc(data.email)}</p>
        <div class="metrics-grid" style="grid-template-columns:repeat(3,1fr);">
            ${metricCard('Active Hours', data.active_hours + 'h', '', '')}
            ${metricCard('Breaks/Hour', data.breaks_per_hour, '', '')}
            ${metricCard('Total Breaks', data.total_breaks, '', '')}
        </div>
        <div class="card" style="margin-top:1rem;">
            <div class="card-title" style="margin-bottom:0.5rem;">Insight</div>
            <p style="font-size:0.85rem;color:var(--text-secondary);">${esc(data.insight)}</p>
        </div>
        <div class="card" style="margin-top:1rem;">
            <div class="card-title" style="margin-bottom:0.5rem;">Activity Calendar (90 days)</div>
            ${calendarHtml}
        </div>
    `;

    panel.classList.add('open');
    document.getElementById('drilldownBackdrop').classList.add('open');
}

// Close drill-down
document.getElementById('drilldownClose').addEventListener('click', closeDrilldown);
document.getElementById('drilldownBackdrop').addEventListener('click', closeDrilldown);
function closeDrilldown() {
    document.getElementById('drilldownPanel').classList.remove('open');
    document.getElementById('drilldownBackdrop').classList.remove('open');
}

// ============== Intelligence ==============
async function loadIntelligence() {
    const [criteria, judge, prompts, mlInfo] = await Promise.all([
        api('criteria'), api('judge'), api('prompts'), api('ml-info')
    ]);

    // Criteria table
    if (criteria?.criteria_stats) {
        document.getElementById('criteriaTableBody').innerHTML = criteria.criteria_stats.slice(0, 30).map(c => `
            <tr>
                <td>${esc(c.id)}</td>
                <td><span class="badge badge-${c.type === 'formatting' ? 'warning' : c.type === 'safety' ? 'danger' : 'muted'}">${c.type}</span></td>
                <td><strong>${c.fail_rate}%</strong></td>
                <td>${c.total}</td>
            </tr>
        `).join('');
    }

    // Judge drift chart
    if (judge?.drift?.length > 0) {
        renderJudgeDrift(judge.drift);
    }

    // Top failure reasons
    if (judge?.top_failure_reasons) {
        document.getElementById('failureReasonsList').innerHTML = judge.top_failure_reasons.slice(0, 10).map(r => `
            <div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
                <span>${esc(r.reason)}</span>
                <span class="badge badge-danger">${r.count}</span>
            </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:0.82rem;">No failure data yet</div>';
    }

    // Prompt clusters
    if (prompts?.clusters) {
        document.getElementById('promptClusterBody').innerHTML = prompts.clusters.map(c => `
            <tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td style="font-size:0.75rem;color:var(--text-muted);">${c.top_terms?.join(', ') || ''}</td>
                <td>${c.count}</td>
            </tr>
        `).join('') || '<tr><td colspan="3" style="color:var(--text-muted);">Need 10+ prompts for clustering</td></tr>';
    }

    // Domain coverage
    if (prompts?.domains) {
        document.getElementById('domainList').innerHTML = prompts.domains.map(d => `
            <div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
                <span class="badge badge-accent">${d.domain}</span>
                <span>${d.count} sessions</span>
            </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:0.82rem;">No data yet</div>';
    }

    // What-if simulator status
    document.getElementById('whatifStatus').textContent = mlInfo?.loaded 
        ? `Model loaded (${mlInfo.accuracy || 'unknown'} accuracy, ${mlInfo.n_samples || '?'} samples)` 
        : 'ML model not loaded - predictions unavailable';

    setupWhatIf(mlInfo?.loaded);
}

function renderJudgeDrift(drift) {
    // Pure HTML/CSS horizontal bars — no canvas, no library, no memory leaks
    const container = document.getElementById('judgeDriftBars');
    if (!container) return;

    // Show last 20 weeks max
    const data = drift.slice(-20);
    if (data.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No judge data yet</div>';
        return;
    }

    container.innerHTML = data.map(d => {
        const pct = Math.min(d.pass_rate, 100);
        const color = pct > 60 ? 'var(--success)' : pct > 40 ? 'var(--warning)' : 'var(--danger)';
        return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;font-size:0.78rem;">
            <span style="width:60px;color:var(--text-muted);text-align:right;flex-shrink:0;">${esc(d.week)}</span>
            <div style="flex:1;height:16px;background:var(--bg);border-radius:3px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;transition:width 0.3s;"></div>
            </div>
            <span style="width:40px;font-weight:600;flex-shrink:0;">${d.pass_rate}%</span>
        </div>`;
    }).join('');
}

// What-If: set up listeners only ONCE (guard flag)
let _whatIfInitialized = false;

function setupWhatIf(mlLoaded) {
    if (!mlLoaded || _whatIfInitialized) return;
    _whatIfInitialized = true;
    const inputs = ['whatifCriteria', 'whatifModel', 'whatifFormatting', 'whatifBudget'];
    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', runWhatIf);
    });
    runWhatIf();
}

async function runWhatIf() {
    const criteria = parseInt(document.getElementById('whatifCriteria').value);
    const model = parseInt(document.getElementById('whatifModel').value);
    const formatting = parseInt(document.getElementById('whatifFormatting').value);
    const budget = parseInt(document.getElementById('whatifBudget').value);

    document.getElementById('whatifCriteriaVal').textContent = criteria;
    document.getElementById('whatifBudgetVal').textContent = budget + '%';

    const features = {
        num_criteria: criteria, model_is_qwen: model,
        has_formatting_criteria: formatting, reasoning_budget: budget / 100
    };

    try {
        const res = await fetch('/api/what-if', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_features: { num_criteria: 5, model_is_qwen: 1, has_formatting_criteria: 0, reasoning_budget: 0.9 }, changes: features })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.new_probability !== undefined) {
                const prob = (data.new_probability * 100).toFixed(1);
                document.getElementById('whatifProb').textContent = prob + '%';
                document.getElementById('whatifProb').style.color = data.new_probability > 0.7 ? 'var(--success)' : data.new_probability > 0.4 ? 'var(--warning)' : 'var(--danger)';
                if (data.delta) {
                    const d = (data.delta * 100).toFixed(1);
                    document.getElementById('whatifDelta').textContent = `${data.delta > 0 ? '+' : ''}${d}% vs baseline`;
                    document.getElementById('whatifDelta').style.color = data.delta > 0 ? 'var(--success)' : 'var(--danger)';
                }
            }
        }
    } catch (e) {
        // Silently fail — ML model may not be loaded
    }
}

// ============== Sessions ==============
async function loadSessions() {
    const sessions = await api('sessions?limit=50');
    if (!sessions) return;
    document.getElementById('sessionsTableBody').innerHTML = sessions.map(s => `
        <tr onclick="loadSessionReplay('${esc(s.session_id)}')">
            <td style="font-family:monospace;font-size:0.78rem;">${s.session_id.slice(0, 8)}</td>
            <td>${esc(s.filename || '-')}</td>
            <td>${esc(s.trainer_name || s.trainer_id || '-')}<br><span style="font-size:0.72rem;color:var(--text-muted);">${esc(s.trainer_email || '')}</span></td>
            <td style="font-size:0.75rem;">${formatTime(s.created_at)}</td>
            <td style="font-size:0.75rem;">${formatTime(s.last_accessed)}</td>
        </tr>
    `).join('');
}

async function loadSessionReplay(sessionId) {
    const events = await api(`session-replay/${sessionId}`);
    if (!events) return;

    document.getElementById('replaySessionId').textContent = sessionId.slice(0, 8);
    const card = document.getElementById('sessionReplayCard');
    card.style.display = 'block';

    const timeline = document.getElementById('replayTimeline');
    timeline.innerHTML = events.map(e => {
        const cls = e.type === 'hunt_result' && e.data?.is_breaking ? 'break' :
                    e.type === 'hunt_result' && e.data?.score === 1 ? 'success' :
                    e.data?.error ? 'error' : '';
        const detail = formatEventDetail(e);
        return `
            <div class="replay-event ${cls}">
                <span class="replay-event-time">${formatTime(e.timestamp)}</span>
                <div class="replay-event-type">${e.type.replace(/_/g, ' ')}</div>
                <div class="replay-event-detail">${detail}</div>
            </div>
        `;
    }).join('');

    card.scrollIntoView({ behavior: 'smooth' });
}

function formatEventDetail(e) {
    const d = e.data || {};
    switch (e.type) {
        case 'session_created': return `Notebook: ${esc(d.notebook || '-')} (${d.source || 'unknown'})`;
        case 'hunt_start': return `${d.workers || '?'} workers, target: ${d.target_breaks || '?'} breaks`;
        case 'hunt_result': return `Hunt #${d.hunt_id || '?'}: ${d.is_breaking ? '🔴 BREAK' : d.score === 1 ? '🟢 PASS' : d.error ? '⚠️ ERROR' : '⏳'}`;
        case 'hunt_complete': return `${d.completed_hunts || 0} hunts, ${d.breaks_found || 0} breaks`;
        case 'api_call_end': return `${d.provider || ''} ${d.model?.split('/').pop() || ''} ${d.latency_ms || 0}ms ${d.success ? '✓' : '✗'}`;
        default: return JSON.stringify(d).slice(0, 100);
    }
}

// ============== Models ==============
async function loadModels() {
    const models = await api('models');
    if (!models) return;

    document.getElementById('modelsTableBody').innerHTML = models.map(m => `
        <tr>
            <td><strong>${esc(m.model.split('/').pop())}</strong></td>
            <td>${m.hunts}</td>
            <td>${m.breaks}</td>
            <td><strong>${m.break_rate}%</strong></td>
            <td>${m.p50_latency}ms</td>
            <td>${m.p95_latency}ms</td>
        </tr>
    `).join('');

    // Vulnerability chart
    const modelsWithVuln = models.filter(m => m.vulnerability && Object.keys(m.vulnerability).length > 0);
    if (modelsWithVuln.length > 0) {
        const allTypes = [...new Set(modelsWithVuln.flatMap(m => Object.keys(m.vulnerability)))];
        const traces = modelsWithVuln.map(m => ({
            y: allTypes,
            x: allTypes.map(t => m.vulnerability[t] || 0),
            name: m.model.split('/').pop(),
            type: 'bar',
            orientation: 'h',
        }));
        Plotly.newPlot('vulnerabilityChart', traces, {
            barmode: 'group',
            paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
            font: { color: '#9ca3af', size: 11 },
            margin: { l: 100, r: 20, t: 10, b: 40 },
            xaxis: { title: 'Fail Rate %', gridcolor: '#2a2d3a' },
            yaxis: { gridcolor: '#2a2d3a' },
            legend: { orientation: 'h', y: -0.2 }
        }, { responsive: true });
    }
}

// ============== Costs ==============
async function loadCosts() {
    const costs = await api('costs');
    if (!costs) return;

    document.getElementById('costMetrics').innerHTML = [
        metricCard('Total Cost', `$${costs.total_cost?.toFixed(2) || '0.00'}`, '', ''),
        metricCard('Cost Per Break', `$${costs.cost_per_break?.toFixed(4) || '0.00'}`, '', ''),
        metricCard('Total Breaks', costs.total_breaks || 0, '', ''),
    ].join('');

    // Cost by model
    document.getElementById('costByModel').innerHTML = (costs.by_model || []).map(m => `
        <div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
            <span>${esc(m.model.split('/').pop())}</span>
            <strong>$${m.cost.toFixed(4)}</strong>
        </div>
    `).join('') || '<div style="color:var(--text-muted);">No cost data</div>';

    // Cost by trainer
    document.getElementById('costByTrainer').innerHTML = (costs.by_trainer || []).slice(0, 10).map(t => `
        <div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
            <span>${esc(t.name || t.email)}</span>
            <strong>$${t.cost.toFixed(4)}</strong>
        </div>
    `).join('') || '<div style="color:var(--text-muted);">No data</div>';

    // Burn rate — pure HTML bars, no canvas
    const burnContainer = document.getElementById('burnRateBars');
    if (costs.burn_rate?.length > 0 && burnContainer) {
        const maxCost = Math.max(...costs.burn_rate.map(d => d.cost), 0.001);
        burnContainer.innerHTML = costs.burn_rate.map(d => {
            const pct = Math.min((d.cost / maxCost) * 100, 100);
            return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;font-size:0.78rem;">
                <span style="width:50px;color:var(--text-muted);text-align:right;flex-shrink:0;">${d.date.slice(5)}</span>
                <div style="flex:1;height:16px;background:var(--bg);border-radius:3px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px;"></div>
                </div>
                <span style="width:55px;font-weight:600;flex-shrink:0;">$${d.cost.toFixed(3)}</span>
            </div>`;
        }).join('');
    } else if (burnContainer) {
        burnContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No cost data yet</div>';
    }
}

// ============== Data Lab ==============
async function loadDataLab() {
    const profiles = await api('export-profiles');
    if (!profiles) return;

    document.getElementById('exportGrid').innerHTML = profiles.map(p => `
        <div class="export-card ${state.selectedExportProfile === p.id ? 'selected' : ''}" onclick="selectExportProfile('${p.id}', '${esc(p.name)}')">
            <h4>${esc(p.name)}</h4>
            <p>${esc(p.description)}</p>
            ${p.label ? `<span class="badge badge-accent" style="margin-top:0.5rem;">Label: ${p.label}</span>` : ''}
        </div>
    `).join('');
}

async function selectExportProfile(profileId, name) {
    state.selectedExportProfile = profileId;
    loadDataLab(); // Refresh selection state

    const preview = await api(`export-preview/${profileId}`);
    if (!preview || !preview.preview?.length) {
        document.getElementById('exportPreviewCard').style.display = 'none';
        return;
    }

    document.getElementById('exportPreviewName').textContent = name;
    document.getElementById('exportPreviewRows').textContent = preview.total_rows;
    document.getElementById('exportPreviewHead').innerHTML = '<tr>' + preview.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
    document.getElementById('exportPreviewBody').innerHTML = preview.preview.map(row =>
        '<tr>' + preview.columns.map(c => `<td>${esc(String(row[c] ?? ''))}</td>`).join('') + '</tr>'
    ).join('');
    document.getElementById('exportPreviewCard').style.display = 'block';

    // Download button
    document.getElementById('exportDownloadBtn').onclick = () => {
        const fmt = document.getElementById('exportFormat').value;
        window.open(`/api/export/${profileId}?fmt=${fmt}&days=30`, '_blank');
    };
}

// ============== System ==============
async function loadSystem() {
    const system = await api('system');
    if (!system) return;

    // Provider health
    const providers = system.provider_health || {};
    document.getElementById('providerTableBody').innerHTML = Object.entries(providers).map(([name, p]) => `
        <tr>
            <td><strong>${esc(name)}</strong></td>
            <td><span class="badge badge-${p.status === 'ok' ? 'success' : p.status === 'degraded' ? 'warning' : 'danger'}">${p.status}</span></td>
            <td>${p.total_calls}</td>
            <td>${p.error_rate}%</td>
            <td>${p.p50_latency}ms</td>
            <td>${p.p95_latency}ms</td>
        </tr>
    `).join('') || '<tr><td colspan="6" style="color:var(--text-muted);">No data</td></tr>';

    // Anomalies
    const anomalies = system.anomalies || [];
    document.getElementById('anomaliesList').innerHTML = anomalies.length > 0
        ? anomalies.map(a => `
            <div style="padding:0.5rem 0;border-bottom:1px solid var(--border);">
                <span class="badge badge-${a.severity === 'critical' ? 'danger' : 'warning'}">${a.severity}</span>
                <span style="margin-left:0.5rem;font-size:0.85rem;">${esc(a.description)}</span>
                <span style="float:right;font-size:0.72rem;color:var(--text-muted);">${formatTime(a.timestamp)}</span>
            </div>
        `).join('')
        : '<div style="color:var(--text-muted);font-size:0.82rem;">No anomalies detected</div>';

    // Cache status
    document.getElementById('cacheStatus').textContent = `Cache: ${system.cache_age_seconds}s ago (${system.total_events} events, ${system.compute_time_ms}ms)`;

    // Admin management + test accounts (super admin only)
    if (state.isSuperAdmin) {
        document.getElementById('adminManagementCard').style.display = 'block';
        document.getElementById('testAccountCard').style.display = 'block';
        await Promise.all([loadAdminList(), loadTestAccounts()]);
    }
}

// ============== Admin Management ==============
async function loadAdminList() {
    const admins = await api('admins');
    if (!admins) return;

    const list = document.getElementById('adminList');
    if (admins.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No admins added yet. Only you (super admin) have access.</div>';
    } else {
        list.innerHTML = admins.map(a => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border);">
                <div>
                    <strong style="font-size:0.85rem;">${esc(a.name || 'No name')}</strong>
                    <span style="color:var(--text-muted);font-size:0.78rem;margin-left:0.5rem;">${esc(a.email)}</span>
                    <span style="color:var(--text-muted);font-size:0.7rem;margin-left:0.5rem;">added ${formatTime(a.added_at)}</span>
                </div>
                <button class="btn btn-secondary" style="font-size:0.75rem;padding:0.25rem 0.6rem;color:var(--danger);" onclick="removeAdminAccess('${esc(a.email)}')">Revoke</button>
            </div>
        `).join('');
    }
}

async function addAdminAccess() {
    const nameInput = document.getElementById('newAdminName');
    const emailInput = document.getElementById('newAdminEmail');
    const email = emailInput.value.trim();
    const name = nameInput.value.trim();
    if (!email) return;

    const res = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
    });
    if (res.ok) {
        emailInput.value = '';
        nameInput.value = '';
        await loadAdminList();
    }
}

async function removeAdminAccess(email) {
    if (!confirm(`Revoke dashboard access for ${email}?`)) return;
    const res = await fetch(`/api/admins/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (res.ok) {
        await loadAdminList();
    }
}

// Wire up add admin button
document.getElementById('addAdminBtn')?.addEventListener('click', addAdminAccess);
document.getElementById('newAdminEmail')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addAdminAccess(); }
});

// ============== Test Account Management ==============
async function loadTestAccounts() {
    const accounts = await api('test-accounts');
    if (!accounts) return;

    const list = document.getElementById('testAccountList');
    if (accounts.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">No test accounts added. All activity is included in analytics.</div>';
    } else {
        list.innerHTML = accounts.map(a => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border);">
                <div>
                    <strong style="font-size:0.85rem;">${esc(a.name || 'No name')}</strong>
                    <span style="color:var(--text-muted);font-size:0.78rem;margin-left:0.5rem;">${esc(a.email)}</span>
                </div>
                <button class="btn btn-secondary" style="font-size:0.75rem;padding:0.25rem 0.6rem;color:var(--danger);" onclick="removeTestAccount('${esc(a.email)}')">Remove</button>
            </div>
        `).join('');
    }
}

async function addTestAccount() {
    const nameInput = document.getElementById('newTestName');
    const emailInput = document.getElementById('newTestEmail');
    const email = emailInput.value.trim();
    const name = nameInput.value.trim();
    if (!email) return;

    const res = await fetch('/api/test-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
    });
    if (res.ok) {
        emailInput.value = '';
        nameInput.value = '';
        await loadTestAccounts();
    }
}

async function removeTestAccount(email) {
    if (!confirm(`Remove ${email} from test accounts? Their data will be included in analytics going forward.`)) return;
    const res = await fetch(`/api/test-accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (res.ok) {
        await loadTestAccounts();
    }
}

document.getElementById('addTestBtn')?.addEventListener('click', addTestAccount);
document.getElementById('newTestEmail')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTestAccount(); }
});

// ============== Live Feed ==============
function startLiveFeed() {
    if (state.liveFeedSource) {
        state.liveFeedSource.close();
    }
    try {
        state.liveFeedSource = new EventSource('/api/live-feed');
        state.liveFeedSource.addEventListener('new_event', (e) => {
            const data = JSON.parse(e.data);
            addFeedEvent(data);
        });
        state.liveFeedSource.onerror = () => {
            // Will auto-reconnect
        };
    } catch (err) {
        console.warn('SSE not available');
    }
}

function addFeedEvent(event) {
    const feed = document.getElementById('liveFeed');
    const icon = {
        'session_created': '📓', 'hunt_start': '🚀', 'hunt_result': event.data?.is_breaking ? '🔴' : '🟢',
        'hunt_complete': '✅', 'api_call_end': '📡', 'trainer_heartbeat': '💓', 'judge_call': '⚖️',
    }[event.type] || '📌';

    const html = `<div class="feed-event">
        <span class="feed-event-icon">${icon}</span>
        <span class="feed-event-time">${new Date(event.timestamp).toLocaleTimeString()}</span>
        <span class="feed-event-text">${event.type.replace(/_/g, ' ')}${event.data?.session_id ? ` (${event.data.session_id.slice(0, 6)})` : ''}</span>
    </div>`;

    feed.insertAdjacentHTML('afterbegin', html);
    // Keep max 30 events
    while (feed.children.length > 30) {
        feed.removeChild(feed.lastChild);
    }
}

// ============== Helpers ==============
function metricCard(label, value, deltaClass, deltaText) {
    return `<div class="metric-card">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
        ${deltaText ? `<div class="metric-delta ${deltaClass}">${deltaText}</div>` : ''}
    </div>`;
}

function deltaClass(delta) {
    if (delta > 0) return 'positive';
    if (delta < 0) return 'negative';
    return 'neutral';
}

function deltaText(delta) {
    if (!delta && delta !== 0) return '';
    return delta > 0 ? `+${delta} vs yesterday` : delta < 0 ? `${delta} vs yesterday` : 'same as yesterday';
}

function formatTime(ts) {
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
        return ts.slice(0, 16);
    }
}

function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

// ============== Auto Refresh ==============
// Refresh every 2 minutes (charts update in place, no re-creation)
state.refreshInterval = setInterval(() => {
    loadSection(state.currentSection);
}, 120000);

// ============== Init ==============
async function initDashboard() {
    // Check who we are
    const me = await api('me');
    if (me) {
        state.isSuperAdmin = me.is_super || false;
        state.currentEmail = me.email || '';
    }
    loadCommandCenter();
}
initDashboard();
