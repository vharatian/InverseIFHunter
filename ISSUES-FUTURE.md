# Known Issues & Future Improvements

Tracked trade-offs and edge cases from the live-streaming implementation (judge SSE + generation SSE) that may need attention later.

---

## 1. No stream cancellation on re-trigger

**Severity**: Medium
**Area**: Frontend (`testbed.js`, `multiturn.js`, `notebook.js`)

If a user clicks "Judge" while a previous judge stream is still in progress, both streams run simultaneously. The second stream's results append below the first's partial results, causing duplicated or garbled UI.

**Fix**: Store the `AbortController` for the active stream and call `.abort()` before starting a new one. Example:

```js
let _judgeAbort = null;
async function triggerJudge(run) {
    _judgeAbort?.abort();
    _judgeAbort = new AbortController();
    const res = await fetch(url, { signal: _judgeAbort.signal, ... });
    // ...
}
```

---

## 2. Partial results on network drop

**Severity**: Medium
**Area**: Frontend (all SSE consumers)

If the network drops mid-stream (laptop sleep, flaky Wi-Fi, VPN reconnect), the user sees partial criteria cards with no error message or resolution. The `ReadableStream` reader just hangs.

**Fix**: Add a client-side timeout. If no SSE event arrives within N seconds, treat as error and show a "Connection lost — retry?" prompt.

```js
let lastEventTime = Date.now();
// In the read loop:
if (Date.now() - lastEventTime > 30000) throw new Error('Stream timeout');
// On each event:
lastEventTime = Date.now();
```

---

## 3. Proxy / CDN buffering negates streaming

**Severity**: Low (depends on deployment)
**Area**: Backend SSE headers, infrastructure

Some corporate proxies, CDNs (CloudFront, Cloudflare without streaming enabled), or reverse proxies (nginx default config) buffer SSE responses. The user would see all criteria appear at once after a delay — identical to the old behavior but with more code complexity.

**Current mitigations**: `X-Accel-Buffering: no` and `Cache-Control: no-cache` headers are already set on all SSE endpoints.

**Fix if needed**: Ensure nginx config has `proxy_buffering off;` for `/api/*-stream/*` routes. For Cloudflare, enable "streaming" on the zone. For AWS ALB/CloudFront, no action needed (they stream by default).

---

## 4. No partial retry / resume

**Severity**: Low
**Area**: Backend (`openai_client.py`)

If a stream breaks after delivering 4 out of 5 criterion results, the only option is to re-judge all 5 from scratch. There's no mechanism to resume or re-evaluate only the missing criteria.

**Fix**: Would require the backend to accept a `skip_criteria` parameter listing already-evaluated criterion IDs. Low priority since full re-evaluation is fast (criteria run in parallel).

---

## 5. Duplicated SSE consumer pattern across 6 call sites

**Severity**: Low (code quality)
**Area**: Frontend (`testbed.js`, `multiturn.js`, `notebook.js`)

The SSE read-loop pattern (fetch → getReader → decode → split lines → parse JSON → dispatch by event type) is copy-pasted across 6 call sites (~50 lines each). Any bug fix or protocol change must be applied in all 6 places.

**Fix**: Extract a shared utility:

```js
// utils.js or a new sseHelper.js
export async function consumeSSE(url, fetchOpts, handlers) {
    const res = await fetch(url, fetchOpts);
    if (!res.ok) { /* error handling */ }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
                const event = JSON.parse(line.slice(6));
                handlers[event.type]?.(event);
            } catch { /* skip malformed */ }
        }
    }
}
```

Then each call site becomes ~10 lines instead of ~50.

---

## 6. Browser resource usage with multiple tabs

**Severity**: Low
**Area**: Frontend

Each streaming connection holds an open `ReadableStream` reader and a long-lived HTTP connection. If a user opens the app in multiple tabs and triggers judges in each, the browser may hit the per-domain connection limit (typically 6 for HTTP/1.1). HTTP/2 multiplexing mitigates this.

**Fix**: No immediate action needed. If it becomes a problem, add a `BroadcastChannel` to coordinate across tabs, or switch to WebSocket for multiplexed streaming.

---

## 7. `asyncio.as_completed` does not preserve order

**Severity**: Info (by design)
**Area**: Backend (`openai_client.py`)

Criteria results arrive in completion order, not C1 → C2 → C3 order. For example, C3 might appear before C1 if it finishes first. This is intentional (fastest possible progressive display), but users may find the non-sequential order surprising.

**Fix (optional)**: On the frontend, sort criteria cards by ID after each insertion, or add the criterion's position/index to the SSE event and use CSS `order` to keep them visually sorted while still animating on arrival.
