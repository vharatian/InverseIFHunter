/**
 * Hunt Channel — WebSocket connection to Elixir edge for real-time hunt updates.
 *
 * Falls back to SSE (/api/hunt-stream/:sessionId, Python) if WebSocket is unavailable.
 * onError path may recover via polling (/api/results/:sessionId) from hunt.js callbacks.
 */
import { Socket } from '../vendor/phoenix.mjs?v=43';

let socket = null;

function _socketPath() {
  const b = document.querySelector('base');
  if (!b || !b.href) return '/socket';
  try {
    return new URL('socket', b.href).pathname;
  } catch {
    return '/socket';
  }
}
let huntChannel = null;
let sseFallback = null;

export function connectHuntChannel(sessionId, userEmail, callbacks) {
  const {
    onHuntStart,
    onHuntProgress,
    onHuntResult,
    onEarlyStop,
    onComplete,
    onError,
    onReconnect
  } = callbacks;

  // Always clean any prior connection before opening a new one.
  disconnectHuntChannel();

  const seenEventIds = new Set();

  function isDuplicateWs(payload) {
    // Key on (event type, hunt_id/trace_id) so different event types sharing a
    // hunt_id (progress + result) don't stomp on each other.
    const data = payload && payload.data ? payload.data : {};
    const type = payload?.type || payload?.event_type || '';
    const id = payload?.trace_id || data.hunt_id || payload?.hunt_id;
    if (!id) return false;
    const key = `${type}:${id}`;
    if (seenEventIds.has(key)) return true;
    seenEventIds.add(key);
    return false;
  }

  try {
    socket = new Socket(_socketPath(), {
      params: { user_email: userEmail }
    });
    socket.connect();

    huntChannel = socket.channel(`hunt:${sessionId}`, {});

    huntChannel.on('event', (payload) => {
      if (isDuplicateWs(payload)) return;

      const type = payload.type || payload.event_type || '';
      const data = payload.data || payload;

      switch (type) {
        case 'hunt.start':
        case 'hunt_start':
          if (onHuntStart) onHuntStart(data);
          break;
        case 'hunt.progress':
        case 'hunt_progress':
          if (onHuntProgress) onHuntProgress(data);
          break;
        case 'hunt.result':
        case 'hunt_result':
          if (onHuntResult) onHuntResult(data);
          break;
        case 'early_stop':
          if (onEarlyStop) onEarlyStop(data);
          break;
        case 'hunt.complete':
        case 'complete':
          if (onComplete) onComplete(data);
          disconnectHuntChannel();
          break;
        case 'hunt.error':
        case 'error':
          if (onError) onError(data);
          break;
        default:
          break;
      }
    });

    huntChannel
      .join()
      .receive('ok', () => {
        console.log(`[HuntChannel] Joined hunt:${sessionId}`);
        fetch(`api/start-hunt/${sessionId}`, { method: 'POST' })
          .then(res => {
            if (!res.ok && callbacks.onError) {
              callbacks.onError({ message: `Failed to start hunt (HTTP ${res.status})`, status: res.status });
            }
          })
          .catch(err => {
            console.warn('[HuntChannel] Failed to submit hunt job:', err);
            if (callbacks.onError) callbacks.onError({ message: 'Failed to start hunt', error: err });
          });
      })
      .receive('error', (resp) => {
        console.warn('[HuntChannel] Join failed:', resp);
        fallbackToSse(sessionId, callbacks);
      });

    socket.onClose(() => {
      if (onReconnect) onReconnect();
    });

    socket.onError(() => {
      console.warn('[HuntChannel] Socket error, falling back to SSE');
      fallbackToSse(sessionId, callbacks);
    });
  } catch (e) {
    console.warn('[HuntChannel] WebSocket init failed, falling back to SSE:', e);
    fallbackToSse(sessionId, callbacks);
  }
}

/**
 * Python FastAPI SSE: named events (hunt_start, hunt_progress, …) on /api/hunt-stream/.
 */
function fallbackToSse(sessionId, callbacks) {
  if (sseFallback) {
    try {
      sseFallback.close();
    } catch (e) { /* ignore */ }
    sseFallback = null;
  }
  disconnectWsOnly();

  const {
    onHuntStart,
    onHuntProgress,
    onHuntResult,
    onEarlyStop,
    onComplete,
    onError
  } = callbacks;

  const seenSseIds = new Set();

  function isDuplicateSse(event) {
    if (event.lastEventId && seenSseIds.has(event.lastEventId)) return true;
    if (event.lastEventId) seenSseIds.add(event.lastEventId);
    return false;
  }

  const eventSource = new EventSource(`api/hunt-stream/${sessionId}`);
  sseFallback = eventSource;

  eventSource.addEventListener('hunt_start', (event) => {
    if (isDuplicateSse(event)) return;
    const data = JSON.parse(event.data);
    if (onHuntStart) onHuntStart(data);
  });

  eventSource.addEventListener('hunt_progress', (event) => {
    if (isDuplicateSse(event)) return;
    const data = JSON.parse(event.data);
    if (onHuntProgress) onHuntProgress(data);
  });

  eventSource.addEventListener('hunt_result', (event) => {
    if (isDuplicateSse(event)) return;
    const data = JSON.parse(event.data);
    if (onHuntResult) onHuntResult(data);
  });

  eventSource.addEventListener('early_stop', (event) => {
    if (isDuplicateSse(event)) return;
    const data = JSON.parse(event.data);
    if (onEarlyStop) onEarlyStop(data);
  });

  eventSource.addEventListener('complete', (event) => {
    if (isDuplicateSse(event)) return;
    const data = JSON.parse(event.data);
    if (onComplete) onComplete(data);
    disconnectHuntChannel();
  });

  eventSource.addEventListener('start', () => {});

  eventSource.addEventListener('error', () => {
    if (eventSource.readyState === EventSource.CLOSED) {
      eventSource.close();
      sseFallback = null;
      if (onError) onError({ message: 'SSE connection lost' });
    }
  });

  eventSource.addEventListener('ping', () => {});
}

function disconnectWsOnly() {
  if (huntChannel) {
    try {
      huntChannel.leave();
    } catch (e) { /* ignore */ }
    huntChannel = null;
  }
  if (socket) {
    try {
      socket.disconnect();
    } catch (e) { /* ignore */ }
    socket = null;
  }
}

export function disconnectHuntChannel() {
  if (sseFallback) {
    try {
      sseFallback.close();
    } catch (e) { /* ignore */ }
    sseFallback = null;
  }
  disconnectWsOnly();
}
