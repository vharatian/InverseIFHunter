/**
 * Live activity feed (SSE)
 */
import { state } from './state.js';
import { LIVE_FEED_MAX_EVENTS } from './config.js';

export function startLiveFeed() {
    if (state.liveFeedSource) state.liveFeedSource.close();
    try {
        state.liveFeedSource = new EventSource('/api/live-feed');
        state.liveFeedSource.addEventListener('new_event', (e) => {
            addFeedEvent(JSON.parse(e.data));
        });
        state.liveFeedSource.onerror = () => {};
    } catch {
        console.warn('SSE not available');
    }
}

function addFeedEvent(event) {
    const feed = document.getElementById('liveFeed');
    if (!feed) return;
    const icon = {
        session_created: '📓', hunt_start: '🚀',
        hunt_result: event.data?.is_breaking ? '🔴' : '🟢',
        hunt_complete: '✅', api_call_end: '📡',
        trainer_heartbeat: '💓', judge_call: '⚖️',
    }[event.type] || '📌';
    const html = `<div class="feed-event">
        <span class="feed-event-icon">${icon}</span>
        <span class="feed-event-time">${new Date(event.timestamp).toLocaleTimeString()}</span>
        <span class="feed-event-text">${event.type.replace(/_/g, ' ')}${event.data?.session_id ? ` (${event.data.session_id.slice(0, 6)})` : ''}</span>
    </div>`;
    feed.insertAdjacentHTML('afterbegin', html);
    while (feed.children.length > LIVE_FEED_MAX_EVENTS) feed.removeChild(feed.lastChild);
}
