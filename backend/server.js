require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { GarminConnect } = require('garmin-connect');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration to allow cross-origin requests
app.use(cors({
    origin: '*', // Allow all origins for Strava syncing
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// These should be set in .env or your hosting provider (e.g. Vercel)
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || `http://localhost:${PORT}/api/strava/callback`;
const APP_DEEP_LINK = process.env.APP_DEEP_LINK || 'velotrain://auth';
// Frontend URL for callback - used for browser/web app redirects
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

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

// 2. Handle OAuth Callback
app.get('/api/strava/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return res.status(400).send(`Authentication failed: ${error}`);
    }

    if (!code) {
        return res.status(400).send("No authorization code provided.");
    }

    try {
        // Exchange code for token securely using the Client Secret
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code'
        });

        const tokenData = response.data;

        // Redirect back to the Electron app using the custom protocol deep link
        // We pass the tokens back in the URL hash or query params
        // Build token params
        const queryParams = new URLSearchParams({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: tokenData.expires_at,
            athlete_id: tokenData.athlete.id
        }).toString();

        // Determine redirect strategy:
        // 1. Try deep link (works in Electron desktop app)
        // 2. Fall back to web app route (works in browser)
        const deepLink = `${APP_DEEP_LINK}?${queryParams}`;
        const webCallbackUrl = `${FRONTEND_URL}/#/strava-callback?${queryParams}`;

        // Serve an HTML page that tries the deep link, then redirects to web app as fallback.
        // This handles both Electron (deep link) and browser (web callback) seamlessly.
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
        // Try to open the Electron deep link
        window.location.href = '${deepLink}';
        // After 1 second, fall back to the web app callback page
        setTimeout(() => {
            window.location.href = '${webCallbackUrl}';
        }, 1000);
    </script>
</body>
</html>
        `);



    } catch (err) {
        console.error('Error exchanging token:', err.response ? err.response.data : err.message);
        res.status(500).json({ 
            error: "Failed to exchange authorization code for token.",
            details: err.message
        });
    }
});

// 3. Refresh Token Endpoint
app.post('/api/strava/refresh', async (req, res) => {
    const { refresh_token } = req.body;

    if (!refresh_token) {
        return res.status(400).json({ error: "No refresh token provided." });
    }

    try {
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refresh_token,
            grant_type: 'refresh_token'
        });

        res.json(response.data);
    } catch (err) {
        console.error('Error refreshing token:', err.response ? err.response.data : err.message);
        res.status(500).json({ error: "Failed to refresh token." });
    }
});

// ========================================
// Garmin Connect Integration
// ========================================

// In-memory Garmin client (per-session; tokens persisted via export/import)
let garminClient = null;
let garminTokens = null;

// 4. Garmin Login
app.post('/api/garmin/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    try {
        garminClient = new GarminConnect({ username, password });
        await garminClient.login();
        
        // Export tokens so we can reuse the session
        garminTokens = garminClient.exportToken();
        
        res.json({ 
            success: true, 
            message: 'Garmin login successful',
            tokens: garminTokens
        });
    } catch (err) {
        console.error('Garmin login error:', err.message);
        garminClient = null;
        garminTokens = null;
        res.status(401).json({ error: `Garmin login failed: ${err.message}` });
    }
});

// 5. Garmin Restore Session (from saved tokens)
app.post('/api/garmin/restore', async (req, res) => {
    const { oauth1, oauth2 } = req.body;

    if (!oauth1 || !oauth2) {
        return res.status(400).json({ error: 'Saved tokens are required.' });
    }

    try {
        // GarminConnect requires credentials even for token restore;
        // pass placeholders since loadToken bypasses login entirely.
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

// 6. Garmin Get Sleep + HRV data for a date
app.get('/api/garmin/sleep', async (req, res) => {
    if (!garminClient) {
        return res.status(401).json({ error: 'Garmin not connected. Please login first.' });
    }

    try {
        const dateStr = req.query.date; // e.g., '2026-03-10'
        const date = dateStr ? new Date(dateStr) : new Date();
        
        const sleepData = await garminClient.getSleepData(date);
        
        if (!sleepData || !sleepData.dailySleepDTO) {
            return res.json({ 
                found: false, 
                message: 'No sleep data for this date' 
            });
        }

        const dto = sleepData.dailySleepDTO;
        const sleepSeconds = dto.sleepTimeSeconds || 0;
        const sleepHours = parseFloat((sleepSeconds / 3600).toFixed(1));
        
        // Sleep quality from Garmin's sleep score (overall value, 0-100)
        const sleepQuality = dto.sleepScores?.overall?.value || null;
        
        // HRV from sleep data
        const avgHrv = sleepData.avgOvernightHrv || null;
        const hrvStatus = sleepData.hrvStatus || null;
        
        // Resting HR from sleep data
        const restingHr = sleepData.restingHeartRate || null;
        
        // Sleep breakdown
        const deepSleepMinutes = Math.round((dto.deepSleepSeconds || 0) / 60);
        const lightSleepMinutes = Math.round((dto.lightSleepSeconds || 0) / 60);
        const remSleepMinutes = Math.round((dto.remSleepSeconds || 0) / 60);
        const awakeSleepMinutes = Math.round((dto.awakeSleepSeconds || 0) / 60);

        // Update tokens if refreshed
        try {
            garminTokens = garminClient.exportToken();
        } catch (e) { /* token export is optional */ }

        res.json({
            found: true,
            date: dto.calendarDate,
            sleepHours,
            sleepQuality,
            avgHrv,
            hrvStatus,
            restingHr,
            deepSleepMinutes,
            lightSleepMinutes,
            remSleepMinutes,
            awakeSleepMinutes,
            tokens: garminTokens
        });
    } catch (err) {
        console.error('Garmin sleep fetch error:', err.message);
        
        // If auth expired, clear session
        if (err.message?.includes('401') || err.message?.includes('auth') || err.message?.includes('login')) {
            garminClient = null;
            garminTokens = null;
            return res.status(401).json({ error: 'Garmin session expired. Please login again.' });
        }
        
        res.status(500).json({ error: `Failed to fetch sleep data: ${err.message}` });
    }
});

// 7. Garmin Get Heart Rate data for a date
app.get('/api/garmin/heartrate', async (req, res) => {
    if (!garminClient) {
        return res.status(401).json({ error: 'Garmin not connected. Please login first.' });
    }

    try {
        const dateStr = req.query.date;
        const date = dateStr ? new Date(dateStr) : new Date();
        
        const hrData = await garminClient.getHeartRate(date);

        // Update tokens if refreshed
        try {
            garminTokens = garminClient.exportToken();
        } catch (e) { /* token export is optional */ }

        res.json({
            found: true,
            data: hrData,
            tokens: garminTokens
        });
    } catch (err) {
        console.error('Garmin HR fetch error:', err.message);
        res.status(500).json({ error: `Failed to fetch heart rate data: ${err.message}` });
    }
});

// 8. Garmin Logout
app.post('/api/garmin/logout', (req, res) => {
    garminClient = null;
    garminTokens = null;
    res.json({ success: true, message: 'Garmin disconnected' });
});

app.listen(PORT, () => {
    console.log(`Strava Proxy Server running on port ${PORT}`);
});
