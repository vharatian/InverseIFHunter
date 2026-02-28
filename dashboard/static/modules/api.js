/**
 * API client for dashboard
 */
export async function api(endpoint) {
    const res = await fetch(`/api/${endpoint}`);
    if (res.status === 401) {
        window.location.reload();
        return null;
    }
    if (!res.ok) return null;
    return res.json();
}
