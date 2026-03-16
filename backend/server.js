require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { GarminConnect } = require('garmin-connect');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || `http://localhost:${PORT}/api/strava/callback`;
const APP_DEEP_LINK = process.env.APP_DEEP_LINK || 'velotrain://auth';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// In-memory Strava token storage - reads from .env
let stravaTokens = {
    access_token: process.env.STRAVA_ACCESS_TOKEN || null,
    refresh_token: process.env.STRAVA_REFRESH_TOKEN || null,
    expires_at: 0
};

// Automated token refresh utility
async function ensureStravaTokenValid() {
    const now = Math.floor(Date.now() / 1000);
    if (!stravaTokens.access_token || stravaTokens.expires_at < now) {
        try {
            const response = await axios.post('https://www.strava.com/oauth/token', {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: stravaTokens.refresh_token,
                grant_type: 'refresh_token'
            });
            const data = response.data;
            stravaTokens.access_token = data.access_token;
            stravaTokens.refresh_token = data.refresh_token;
            stravaTokens.expires_at = data.expires_at;
            return stravaTokens.access_token;
        } catch (err) {
            console.error('Error auto-refreshing Strava token:', err.response ? err.response.data : err.message);
            return null;
        }
    }
    return stravaTokens.access_token;
}

// 1. Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Strava Proxy Server is running',
        timestamp: new Date().toISOString()
    });
});

// 2. Initiate OAuth Flow
app.get('/api/strava/login', (req, res) => {
    if (!CLIENT_ID) return res.status(500).send("Strava Client ID not configured.");
    const scope = 'read,activity:read_all';
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&approval_prompt=force&scope=${scope}`;
    res.redirect(authUrl);
});

// 3. Handle OAuth Callback
app.get('/api/strava/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Authentication failed: ${error}`);
    if (!code) return res.status(400).send("No authorization code provided.");

    try {
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code'
        });

        const tokenData = response.data;
        stravaTokens.access_token = tokenData.access_token;
        stravaTokens.refresh_token = tokenData.refresh_token;
        stravaTokens.expires_at = tokenData.expires_at;

        const queryParams = new URLSearchParams({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: tokenData.expires_at,
            athlete_id: tokenData.athlete.id
        }).toString();

        const deepLink = `${APP_DEEP_LINK}?${queryParams}`;
        const webCallbackUrl = `${FRONTEND_URL}/#/strava-callback?${queryParams}`;

        res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Connecting to VeloTrain...</title>
    <style>
        body { display:flex; flex-direction:column; align-items:center; justify-content:center;
               height:100vh; margin:0; font-family:sans-serif; background:#0d1117; color:#e2e8f0; }
        p { font-size:1.1rem; }
        .spin { width:40px;height:40px; border:4px solid rgba(255,255,255,0.1);
                border-top:4px solid #fc4c02; border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
    </style>
</head>
<body>
    <div class="spin"></div>
    <p>Connecting your Strava account...</p>
    <script>
        window.location.href = '${deepLink}';
        setTimeout(() => { window.location.href = '${webCallbackUrl}'; }, 1000);
    </script>
</body>
</html>
        `);
    } catch (err) {
        console.error('Error exchanging token:', err.response ? err.response.data : err.message);
        res.status(500).json({ error: "Failed to exchange authorization code for token.", details: err.message });
    }
});

// 4. Refresh Token Endpoint - FIXED
app.post('/api/strava/refresh', async (req, res) => {
    const { refresh_token } = req.body;

    if (refresh_token) {
        stravaTokens.refresh_token = refresh_token;
    }

    if (!stravaTokens.refresh_token) {
        return res.status(400).json({ error: 'No refresh token available.' });
    }

    try {
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: stravaTokens.refresh_token,
            grant_type: 'refresh_token'
        });

        const data = response.data;
        stravaTokens.access_token = data.access_token;
        stravaTokens.refresh_token = data.refresh_token;
        stravaTokens.expires_at = data.expires_at;

        console.log('Strava token refreshed successfully');

        res.json({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_at
        });
    } catch (err) {
        console.error('Error refreshing Strava token:', err.response ? err.response.data : err.message);
        res.status(500).json({
            error: 'Failed to refresh token.',
            details: err.response ? err.response.data : err.message
        });
    }
});

// 5. Strava User Endpoint
app.get('/api/strava/user', async (req, res) => {
    const token = await ensureStravaTokenValid();
    if (!token) return res.status(500).json({ error: 'Failed to refresh Strava token.' });
    try {
        const userResp = await axios.get('https://www.strava.com/api/v3/athlete', {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(userResp.data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch Strava user.', details: err.message });
    }
});

// ========================================
// Garmin Connect Integration
// ========================================

let garminClient = null;
let garminTokens = null;

// 6. Garmin Login
app.post('/api/garmin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    try {
        garminClient = new GarminConnect({ username, password });
        await garminClient.login();
        garminTokens = garminClient.exportToken();
        res.json({ success: true, message: 'Garmin login successful', tokens: garminTokens });
    } catch (err) {
        console.error('Garmin login error:', err.message);
        garminClient = null;
        garminTokens = null;
        res.status(401).json({ error: `Garmin login failed: ${err.message}` });
    }
});

// 7. Garmin Restore Session
app.post('/api/garmin/restore', async (req, res) => {
    const { oauth1, oauth2 } = req.body;
    if (!oauth1 || !oauth2) return res.status(400).json({ error: 'Saved tokens are required.' });

    try {
        garminClient = new GarminConnect({ username: '_', password: '_' });
        garminClient.loadToken(oauth1, oauth2);
        garminTokens = { oauth1, oauth2 };
        res.json({ success: true, message: 'Garmin session restored' });
    } catch (err) {
        console.error('Garmin restore error:', err.message);
        garminClient = null;
        garminTokens = null;
        res.status(401).json({ error: `Failed to restore session: ${err.message}` });
    }
});

// 8. Garmin Sleep + HRV
app.get('/api/garmin/sleep', async (req, res) => {
    if (!garminClient) return res.status(401).json({ error: 'Garmin not connected. Please login first.' });

    try {
        const dateStr = req.query.date;
        const date = dateStr ? new Date(dateStr) : new Date();
        const sleepData = await garminClient.getSleepData(date);

        if (!sleepData || !sleepData.dailySleepDTO) {
            return res.json({ found: false, message: 'No sleep data for this date' });
        }

        const dto = sleepData.dailySleepDTO;
        const sleepSeconds = dto.sleepTimeSeconds || 0;
        const sleepHours = parseFloat((sleepSeconds / 3600).toFixed(1));
        const sleepQuality = dto.sleepScores?.overall?.value || null;
        const avgHrv = sleepData.avgOvernightHrv || null;
        const hrvStatus = sleepData.hrvStatus || null;
        const restingHr = sleepData.restingHeartRate || null;
        const deepSleepMinutes = Math.round((dto.deepSleepSeconds || 0) / 60);
        const lightSleepMinutes = Math.round((dto.lightSleepSeconds || 0) / 60);
        const remSleepMinutes = Math.round((dto.remSleepSeconds || 0) / 60);
        const awakeSleepMinutes = Math.round((dto.awakeSleepSeconds || 0) / 60);

        try { garminTokens = garminClient.exportToken(); } catch (e) {}

        res.json({
            found: true, date: dto.calendarDate, sleepHours, sleepQuality,
            avgHrv, hrvStatus, restingHr, deepSleepMinutes, lightSleepMinutes,
            remSleepMinutes, awakeSleepMinutes, tokens: garminTokens
        });
    } catch (err) {
        console.error('Garmin sleep fetch error:', err.message);
        if (err.message?.includes('401') || err.message?.includes('auth') || err.message?.includes('login')) {
            garminClient = null;
            garminTokens = null;
            return res.status(401).json({ error: 'Garmin session expired. Please login again.' });
        }
        res.status(500).json({ error: `Failed to fetch sleep data: ${err.message}` });
    }
});

// 9. Garmin Heart Rate
app.get('/api/garmin/heartrate', async (req, res) => {
    if (!garminClient) return res.status(401).json({ error: 'Garmin not connected. Please login first.' });

    try {
        const dateStr = req.query.date;
        const date = dateStr ? new Date(dateStr) : new Date();
        const hrData = await garminClient.getHeartRate(date);
        try { garminTokens = garminClient.exportToken(); } catch (e) {}
        res.json({ found: true, data: hrData, tokens: garminTokens });
    } catch (err) {
        console.error('Garmin HR fetch error:', err.message);
        res.status(500).json({ error: `Failed to fetch heart rate data: ${err.message}` });
    }
});

// 10. Garmin Activities (cycling)
app.get('/api/garmin/activities', async (req, res) => {
    if (!garminClient) return res.status(401).json({ error: 'Garmin not connected. Please login first.' });

    try {
        const start = parseInt(req.query.start) || 0;
        const limit = parseInt(req.query.limit) || 50;

        const activities = await garminClient.getActivities(start, limit);
        try { garminTokens = garminClient.exportToken(); } catch (e) {}

        // Filter to cycling-type activities on the server side
        const cyclingTypeKeys = ['cycling', 'indoor_cycling', 'virtual_ride', 'road_cycling', 'mountain_biking', 'gravel_cycling', 'recumbent_cycling'];
        const cyclingActivities = (activities || []).filter(a => {
            const typeKey = (a.activityType?.typeKey || '').toLowerCase();
            return cyclingTypeKeys.some(ct => typeKey.includes(ct) || typeKey.includes('cycling') || typeKey.includes('biking'));
        });

        // Map to a normalized shape with all relevant fields
        const mapped = cyclingActivities.map(a => {
            // Garmin returns startTimeGMT as "YYYY-MM-DD HH:MM:SS" (no timezone marker).
            // Appending 'Z' forces correct UTC parsing so dedup comparisons work
            // regardless of the user's local timezone.
            const startTimeUtc = a.startTimeGMT
                ? new Date(a.startTimeGMT.replace(' ', 'T') + 'Z').toISOString()
                : (a.startTimeLocal ? new Date(a.startTimeLocal).toISOString() : null);

            return {
            garmin_id: a.activityId,
            name: a.activityName || 'Garmin Ride',
            start_time: startTimeUtc,
            total_elapsed_time: Math.round(a.elapsedDuration || a.duration || 0), // Garmin returns seconds
            moving_time: Math.round(a.movingDuration || 0),
            total_distance: a.distance || 0, // In meters
            avg_speed: a.averageSpeed || 0,   // m/s
            max_speed: a.maxSpeed || 0,
            avg_heart_rate: a.averageHR || 0,
            max_heart_rate: a.maxHR || 0,
            avg_power: a.avgPower || 0,
            max_power: a.maxPower || 0,
            normalized_power: a.normPower || a.avgPower || 0,
            avg_cadence: a.averageBikingCadenceInRevPerMinute || 0,
            calories: a.calories || 0,
            elevation_gain: a.elevationGain || 0,
            elevation_loss: a.elevationLoss || 0,
            training_stress_score: a.trainingStressScore || null,
            intensity_factor: a.intensityFactor || null,
            aerobic_te: a.aerobicTrainingEffect || null,
            anaerobic_te: a.anaerobicTrainingEffect || null,
            vo2max: a.vO2MaxValue || null,
            max_20min_power: a.max20MinPower || null,
            // Power curve data
            power_curve: {
                duration_1s: a.maxAvgPower_1 || null,
                duration_5s: a.maxAvgPower_5 || null,
                duration_10s: a.maxAvgPower_10 || null,
                duration_30s: a.maxAvgPower_30 || null,
                duration_1m: a.maxAvgPower_60 || null,
                duration_2m: a.maxAvgPower_120 || null,
                duration_5m: a.maxAvgPower_300 || null,
                duration_10m: a.maxAvgPower_600 || null,
                duration_20m: a.maxAvgPower_1200 || null,
                duration_30m: a.maxAvgPower_1800 || null,
                duration_60m: a.maxAvgPower_3600 || null,
            }
            };
        });

        res.json({ found: true, activities: mapped, total: mapped.length, tokens: garminTokens });
    } catch (err) {
        console.error('Garmin activities fetch error:', err.message);
        if (err.message?.includes('401') || err.message?.includes('auth') || err.message?.includes('login')) {
            garminClient = null;
            garminTokens = null;
            return res.status(401).json({ error: 'Garmin session expired. Please login again.' });
        }
        res.status(500).json({ error: `Failed to fetch activities: ${err.message}` });
    }
});

// 11. Garmin Logout
app.post('/api/garmin/logout', (req, res) => {
    garminClient = null;
    garminTokens = null;
    res.json({ success: true, message: 'Garmin disconnected' });
});

app.listen(PORT, () => {
    console.log(`Strava Proxy Server running on port ${PORT}`);
});