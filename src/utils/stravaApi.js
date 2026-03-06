import { db } from './db';

const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

// In production, set 'proxy_url' in db settings to your deployed Vercel URL.
// e.g. db.saveSettings('proxy_url', 'https://velotrain-proxy.vercel.app')
const getProxyUrl = async () => {
    const saved = await db.getSettings('proxy_url');
    return saved || 'http://localhost:3000';
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
            const res = await fetch(`${proxyUrl}/api/strava/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken })
            });

            if (!res.ok) throw new Error("Failed to refresh token via proxy");

            const data = await res.json();
            
            // Update storage
            await db.saveSettings('strava_access_token', data.access_token);
            await db.saveSettings('strava_refresh_token', data.refresh_token);
            await db.saveSettings('strava_expires_at', data.expires_at);

            accessToken = data.access_token;
        } catch(err) {
            console.error("Token refresh failed:", err);
            throw err;
        }
    }

    return accessToken;
};

/**
 * Fetches recent activities for the user after a certain date.
 * @param {number} afterEpoch - Unix epoch timestamp in seconds
 */
export const fetchStravaActivities = async (afterEpoch) => {
    const token = await getValidStravaToken();
    
    // Default to last 30 days if no epoch provided
    const after = afterEpoch || Math.floor((Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000);

    const res = await fetch(`${STRAVA_API_BASE}/athlete/activities?after=${after}&per_page=30`, {
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    if (!res.ok) throw new Error("Failed to fetch activities");
    return await res.json();
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
        const res = await fetch(`${STRAVA_API_BASE}/activities/${activityId}/streams?keys=${keys}&key_by_type=true`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!res.ok) {
            if (res.status === 404) return null; // No streams or manual activity
            throw new Error(`Failed to fetch streams for ${activityId}`);
        }
        
        return await res.json();
    } catch(err) {
        console.warn(`Could not fetch streams for ${activityId}:`, err);
        return null;
    }
};
