/**
 * Data Lab section
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { state } from '../state.js';

export async function loadDataLab() {
    const profiles = await api('export-profiles');
    if (!profiles) return;

    document.getElementById('exportGrid').innerHTML = profiles.map(p => `
        <div class="export-card ${state.selectedExportProfile === p.id ? 'selected' : ''}" data-profile-id="${p.id}">
            <h4>${esc(p.name)}</h4>
            <p>${esc(p.description)}</p>
            ${p.label ? `<span class="badge badge-accent" style="margin-top:0.5rem;">Label: ${p.label}</span>` : ''}
        </div>
    `).join('');
}

export async function selectExportProfile(profileId, name) {
    state.selectedExportProfile = profileId;
    await loadDataLab();

    const preview = await api(`export-preview/${profileId}`);
    const card = document.getElementById('exportPreviewCard');
    if (!preview?.preview?.length) {
        card.style.display = 'none';
        return;
    }

    document.getElementById('exportPreviewName').textContent = name;
    document.getElementById('exportPreviewRows').textContent = preview.total_rows;
    document.getElementById('exportPreviewHead').innerHTML = '<tr>' + preview.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
    document.getElementById('exportPreviewBody').innerHTML = preview.preview.map(row =>
        '<tr>' + preview.columns.map(c => `<td>${esc(String(row[c] ?? ''))}</td>`).join('') + '</tr>'
    ).join('');
    card.style.display = 'block';

    document.getElementById('exportDownloadBtn').onclick = () => {
        const fmt = document.getElementById('exportFormat')?.value || 'csv';
        window.open(`/api/export/${profileId}?fmt=${fmt}&days=30`, '_blank');
    };
}
