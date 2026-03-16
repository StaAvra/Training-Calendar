import { db } from './db';

const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

/**
 * Gets the proxy URL dynamically:
 * 1. Check if explicitly saved in settings (user configured)
 * 2. Auto-detect from current location if running in browser
 * 3. Fall back to localhost:3000 for development
 */
const getProxyUrl = async () => {
    // First, check if user explicitly set a proxy URL
    const saved = await db.getSettings('proxy_url');
    if (saved) {
        console.log(`Using saved proxy URL: ${saved}`);
        return saved;
    }

    // Auto-detect: if running in browser and not on localhost, use same backend origin
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port } = window.location;
        
        // If NOT localhost/127.0.0.1, assume backend is on same host
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            // Try using same host with port 3000 first (common for Node backends)
            const autoDetected = `${protocol}//${hostname}:3000`;
            console.log(`Auto-detecting proxy URL: ${autoDetected}`);
            return autoDetected;
        }
    }

    // Default to localhost for development
    console.log('Using default proxy URL: http://localhost:3000');
    return 'http://localhost:3000';
};

/**
 * Tests if the proxy server is reachable
 */
export const testProxyConnection = async () => {
    try {
        const proxyUrl = await getProxyUrl();
        const res = await fetch(`${proxyUrl}/api/health`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (res.ok) {
            const data = await res.json();
            console.log(`✓ Proxy server is reachable at ${proxyUrl}:`, data);
            return { ok: true, url: proxyUrl, data };
        } else {
            console.error(`✗ Proxy server at ${proxyUrl} returned status ${res.status}`);
            return { ok: false, url: proxyUrl, status: res.status };
        }
    } catch (err) {
        const proxyUrl = await getProxyUrl();
        console.error(`✗ Cannot reach proxy server at ${proxyUrl}:`, err.message);
        return { ok: false, url: proxyUrl, error: err.message };
    }
};

/**
 * Ensures we have a valid access token, requesting a refresh if necessary.
 */
export const getValidStravaToken = async () => {
    let accessToken = await db.getSettings('strava_access_token');
    const refreshToken = await db.getSettings('strava_refresh_token');
    const expiresAt = await db.getSettings('strava_expires_at');

    if (!accessToken || !refreshToken) {
        throw new Error("Strava is not connected.");
    }

    // Check if near expiration (within 5 minutes)
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (expiresAt && (nowEpoch + 300 > expiresAt)) {
        try {
            const proxyUrl = await getProxyUrl();
            console.log(`Token expired, refreshing via proxy: ${proxyUrl}`);
            
            const res = await fetch(`${proxyUrl}/api/strava/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to refresh token via proxy (${res.status}): ${errText}`);
            }

            const data = await res.json();
            
            // Update storage
            await db.saveSettings('strava_access_token', data.access_token);
            await db.saveSettings('strava_refresh_token', data.refresh_token);
            await db.saveSettings('strava_expires_at', data.expires_at);

            accessToken = data.access_token;
            console.log('Token refreshed successfully');
        } catch(err) {
            console.error("Token refresh failed:", err);
            throw err;
        }
    }

    return accessToken;
};

/**
 * Fetches recent activities for the user after a certain date.
 * Paginates through all results (Strava returns max 30 per page).
 * @param {number} afterEpoch - Unix epoch timestamp in seconds
 * @param {number} [beforeEpoch] - Optional upper bound epoch timestamp in seconds
 */
export const fetchStravaActivities = async (afterEpoch, beforeEpoch) => {
    const token = await getValidStravaToken();
    
    // Default to last 30 days if no epoch provided
    const after = afterEpoch || Math.floor((Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000);

    try {
        let allActivities = [];
        let page = 1;
        const perPage = 50;

        while (true) {
            let url = `${STRAVA_API_BASE}/athlete/activities?after=${after}&per_page=${perPage}&page=${page}`;
            if (beforeEpoch) url += `&before=${beforeEpoch}`;
            console.log(`Fetching Strava activities page ${page}: ${url}`);
            
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to fetch activities (${res.status}): ${errText}`);
            }
            
            const data = await res.json();
            console.log(`Page ${page}: fetched ${data.length} activities`);
            
            if (!data || data.length === 0) break;
            
            allActivities = allActivities.concat(data);
            
            // If we got fewer than perPage, we've reached the end
            if (data.length < perPage) break;
            page++;
        }
        
        console.log(`Total: fetched ${allActivities.length} activities from Strava`);
        return allActivities;
    } catch (err) {
        console.error('Error fetching Strava activities:', err);
        throw err;
    }
};

/**
 * Fetches streams for a given activity ID.
 * @param {number|string} activityId 
 */
export const fetchStravaStreams = async (activityId) => {
    const token = await getValidStravaToken();
    
    // The keys we care about based on fitParser.js
    const keys = 'time,watts,heartrate,cadence,distance,velocity_smooth,altitude,grade_smooth';

    try {
        const url = `${STRAVA_API_BASE}/activities/${activityId}/streams?keys=${keys}&key_by_type=true`;
        console.log(`Fetching streams for activity ${activityId}`);
        
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!res.ok) {
            if (res.status === 404) {
                console.log(`No streams available for activity ${activityId}`);
                return null; // No streams or manual activity
            }
            const errText = await res.text();
            throw new Error(`Failed to fetch streams for ${activityId} (${res.status}): ${errText}`);
        }
        
        const data = await res.json();
        console.log(`Successfully fetched streams for activity ${activityId}`);
        return data;
    } catch(err) {
        console.warn(`Could not fetch streams for ${activityId}:`, err.message);
        return null;
    }
};
