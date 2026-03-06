require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// These should be set in .env or your hosting provider (e.g. Vercel)
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || `http://localhost:${PORT}/api/strava/callback`;
const APP_DEEP_LINK = process.env.APP_DEEP_LINK || 'velotrain://auth';

// 1. Initiate OAuth Flow
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
        const webCallbackUrl = `http://localhost:5173/#/strava-callback?${queryParams}`;

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
        res.status(500).send("Failed to exchange authorization code for token.");
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

app.listen(PORT, () => {
    console.log(`Strava Proxy Server running on port ${PORT}`);
});
