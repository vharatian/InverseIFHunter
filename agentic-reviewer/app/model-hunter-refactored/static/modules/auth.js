/**
 * Model Hunter - Trainer Authentication & Heartbeat
 * @module auth
 * 
 * Handles trainer registration (name + email), identity display,
 * and the 60s heartbeat for activity tracking.
 * 
// ============== Trainer Registration ==============

 */

import { state } from './state.js';
import { showToast } from './celebrations.js';

/**
 * Get trainer info from localStorage.
 * @returns {{ email: string, name: string } | null}
 */
export function getTrainerInfo() {
    const email = localStorage.getItem('trainer_email');
    const name = localStorage.getItem('trainer_name');
    if (email && name) {
        return { email, name };
    }
    return null;
}

export function isTrainerRegistered() {
    return getTrainerInfo() !== null;
}

export function showTrainerIdentity() {
    const info = getTrainerInfo();
    const identityEl = document.getElementById('trainerIdentity');
    const labelEl = document.getElementById('trainerIdentityLabel');
    if (info && identityEl && labelEl) {
        labelEl.textContent = `${info.name} (${info.email})`;
        identityEl.style.display = 'flex';
    }
}

export function hideTrainerRegistration() {
    const modal = document.getElementById('trainerRegistrationModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

export function showTrainerRegistration() {
    const modal = document.getElementById('trainerRegistrationModal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

export async function registerTrainer(name, email) {
    // Save to localStorage immediately
    localStorage.setItem('trainer_name', name);
    localStorage.setItem('trainer_email', email);
    
    // Register with backend (fire-and-forget, don't block on failure)
    try {
        await fetch('/api/register-trainer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email })
        });
    } catch (e) {
        // Backend registration is best-effort — localStorage is the source of truth for the frontend
        console.warn('Trainer registration API call failed (non-blocking):', e);
    }
}

export function initTrainerRegistration() {
    const form = document.getElementById('trainerRegForm');
    const changeBtn = document.getElementById('trainerChangeBtn');
    
    if (isTrainerRegistered()) {
        // Already registered — hide modal, show identity
        hideTrainerRegistration();
        showTrainerIdentity();
        // Silent re-register to update last_seen on backend
        const info = getTrainerInfo();
        registerTrainer(info.name, info.email);
    }
    // If not registered, modal is already visible (not hidden by default)
    
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nameInput = document.getElementById('trainerNameInput');
            const emailInput = document.getElementById('trainerEmailInput');
            
            const name = nameInput.value.trim();
            const email = emailInput.value.trim();
            
            if (!name || !email) return;
            
            // Basic email format check
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                // Use imported showToast
                showToast('Please enter a valid email address', 'error');
                return;
            }
            
            // Save to localStorage FIRST (this is the source of truth)
            localStorage.setItem('trainer_name', name);
            localStorage.setItem('trainer_email', email);
            
            // Hide modal and show identity IMMEDIATELY (don't wait for API)
            hideTrainerRegistration();
            showTrainerIdentity();
            
            // Register with backend in background (fire-and-forget)
            registerTrainer(name, email);
        });
    }
    
    if (changeBtn) {
        changeBtn.addEventListener('click', () => {
            localStorage.removeItem('trainer_name');
            localStorage.removeItem('trainer_email');
            const identityEl = document.getElementById('trainerIdentity');
            if (identityEl) identityEl.style.display = 'none';
            // Pre-fill with previous values for convenience
            const info = getTrainerInfo();
            showTrainerRegistration();
            // Focus the name field
            const nameInput = document.getElementById('trainerNameInput');
            if (nameInput) nameInput.focus();
        });
    }
}


// ============== Heartbeat ==============

let _heartbeatInterval = null;

export function startHeartbeat() {
    if (_heartbeatInterval) return;
    _heartbeatInterval = setInterval(() => {
        const email = localStorage.getItem('trainer_email');
        const sessionId = state.sessionId ?? null;
        if (document.visibilityState === 'visible' && sessionId && email) {
            fetch('/api/heartbeat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, trainer_email: email })
            }).catch(() => {}); // fire-and-forget
        }
    }, 60000);
}

export function stopHeartbeat() {
    if (_heartbeatInterval) {
        clearInterval(_heartbeatInterval);
        _heartbeatInterval = null;
    }
}

/**
 * Initialize visibility-based heartbeat restart.
 */
export function initHeartbeatVisibility() {
    document.addEventListener('visibilitychange', () => {
        const sessionId = state.sessionId;
        if (document.visibilityState === 'visible' && sessionId) {
            startHeartbeat();
        }
    });
}
