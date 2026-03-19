import { db } from './db';

/**
 * Gets the backend proxy URL.
 * Uses relative URL by default (works through Vite proxy or same-origin setups).
 * Falls back to explicit proxy_url setting if configured.
 */
const getProxyUrl = async () => {
    const saved = await db.getSettings('proxy_url');
    if (saved) return saved;

    // Use relative URL - works through Vite proxy in dev,
    // and through same-origin in production
    return '';
};

/**
 * Safely parse a JSON response, with a clear error if it's HTML instead.
 */
const safeJson = async (res) => {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        // If the response is HTML, the backend is unreachable
        if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
            throw new Error('Backend server not reachable. Make sure the backend is running on port 3000.');
        }
        throw new Error(`Invalid response from server: ${text.substring(0, 100)}`);
    }
};

/**
 * Login to Garmin Connect via the backend proxy.
 * Credentials are only sent to our own backend, which authenticates with Garmin.
 */
export const garminLogin = async (username, password) => {
    const proxyUrl = await getProxyUrl();
    const res = await fetch(`${proxyUrl}/api/garmin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
        const err = await safeJson(res);
        throw new Error(err.error || 'Garmin login failed');
    }

    const data = await safeJson(res);

    // Save tokens for session reuse
    if (data.tokens) {
        await db.saveSettings('garmin_tokens', data.tokens);
    }
    await db.saveSettings('garmin_connected', true);

    return data;
};

/**
 * Restore Garmin session from saved tokens.
 */
export const garminRestore = async () => {
    const tokens = await db.getSettings('garmin_tokens');
    if (!tokens || !tokens.oauth1 || !tokens.oauth2) {
        return false;
    }

    const proxyUrl = await getProxyUrl();
    const res = await fetch(`${proxyUrl}/api/garmin/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tokens)
    });

    if (!res.ok) {
        // Tokens expired, clear them
        await db.saveSettings('garmin_connected', false);
        return false;
    }

    return true;
};

/**
 * Fetch sleep + HRV data for a given date.
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Object} { sleepHours, sleepQuality, avgHrv, hrvStatus, restingHr, ... }
 */
export const fetchGarminSleepData = async (dateStr) => {
    // Try to restore session first
    const restored = await garminRestore();
    if (!restored) {
        throw new Error('Garmin session expired. Please login again from Profile.');
    }

    const proxyUrl = await getProxyUrl();
    const res = await fetch(`${proxyUrl}/api/garmin/sleep?date=${encodeURIComponent(dateStr)}`);

    if (!res.ok) {
        const err = await safeJson(res);
        if (res.status === 401) {
            await db.saveSettings('garmin_connected', false);
        }
        throw new Error(err.error || 'Failed to fetch Garmin sleep data');
    }

    const data = await safeJson(res);

    // Update stored tokens if refreshed
    if (data.tokens) {
        await db.saveSettings('garmin_tokens', data.tokens);
    }

    return data;
};

/**
 * Logout from Garmin and clear saved tokens.
 */
export const garminLogout = async () => {
    const proxyUrl = await getProxyUrl();
    try {
        await fetch(`${proxyUrl}/api/garmin/logout`, { method: 'POST' });
    } catch (e) { /* ignore */ }

    await db.saveSettings('garmin_connected', false);
    await db.saveSettings('garmin_tokens', null);
};

/**
 * Fetch cycling activities from Garmin Connect.
 * Paginates through all results.
 * @param {number} [maxActivities=200] - Maximum number of activities to fetch
 * @returns {Array} Array of normalized activity objects
 */
export const fetchGarminActivities = async (maxActivities = 200) => {
    const restored = await garminRestore();
    if (!restored) {
        throw new Error('Garmin session expired. Please login again from Profile.');
    }

    const proxyUrl = await getProxyUrl();
    let allActivities = [];
    let start = 0;
    const pageSize = 50;

    while (allActivities.length < maxActivities) {
        const res = await fetch(`${proxyUrl}/api/garmin/activities?start=${start}&limit=${pageSize}`);

        if (!res.ok) {
            const err = await safeJson(res);
            if (res.status === 401) {
                await db.saveSettings('garmin_connected', false);
            }
            throw new Error(err.error || 'Failed to fetch Garmin activities');
        }

        const data = await safeJson(res);

        if (data.tokens) {
            await db.saveSettings('garmin_tokens', data.tokens);
        }

        if (!data.activities || data.activities.length === 0) break;

        allActivities = allActivities.concat(data.activities);

        if (data.activities.length < pageSize) break;
        start += pageSize;
    }

    return allActivities.slice(0, maxActivities);
};

/**
 * Fetch per-trackpoint streams for a Garmin activity.
 * @param {number|string} activityId Garmin activity id
 * @returns {Array} [{ time, power, heart_rate, cadence, speed, distance }]
 */
export const fetchGarminActivityStreams = async (activityId) => {
    const restored = await garminRestore();
    if (!restored) {
        throw new Error('Garmin session expired. Please login again from Profile.');
    }

    const proxyUrl = await getProxyUrl();
    const res = await fetch(`${proxyUrl}/api/garmin/activities/${encodeURIComponent(activityId)}/streams`);

    if (!res.ok) {
        const err = await safeJson(res);
        if (res.status === 401) {
            await db.saveSettings('garmin_connected', false);
        }
        throw new Error(err.error || 'Failed to fetch Garmin activity streams');
    }

    const data = await safeJson(res);
    if (data.tokens) {
        await db.saveSettings('garmin_tokens', data.tokens);
    }

    return Array.isArray(data.streams) ? data.streams : [];
};
