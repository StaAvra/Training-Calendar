import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../utils/db';

const StravaCallback = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [message, setMessage] = useState('Completing Strava connection...');
    const [isError, setIsError] = useState(false);

    useEffect(() => {
        const handleCallback = async () => {
            const accessToken = searchParams.get('access_token');
            const refreshToken = searchParams.get('refresh_token');
            const expiresAt = searchParams.get('expires_at');
            const athleteId = searchParams.get('athlete_id');

            console.log('StravaCallback received:', { accessToken: !!accessToken, refreshToken: !!refreshToken, expiresAt, athleteId });

            if (!accessToken) {
                setIsError(true);
                setMessage('Connection failed: no token received. Please try again.');
                console.error('No access token in callback params');
                setTimeout(() => navigate('/profile'), 3000);
                return;
            }

            try {
                await db.saveSettings('strava_access_token', accessToken);
                await db.saveSettings('strava_refresh_token', refreshToken);
                await db.saveSettings('strava_expires_at', Number(expiresAt));
                if (athleteId) {
                    await db.saveSettings('strava_athlete_id', athleteId);
                }
                
                console.log('Strava tokens saved successfully');
                setMessage('Strava connected successfully! Redirecting...');
                setTimeout(() => navigate('/profile'), 2000);
            } catch (err) {
                console.error('Failed to save Strava tokens:', err);
                setIsError(true);
                setMessage(`Failed to save connection: ${err.message}. Please try again.`);
                setTimeout(() => navigate('/profile'), 3000);
            }
        };

        handleCallback();
    }, [navigate, searchParams]);

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            gap: '16px',
            fontFamily: 'var(--font-sans, sans-serif)',
            background: 'var(--bg-primary, #0d1117)',
            color: 'var(--text-primary, #fff)'
        }}>
            {!isError && (
                <div style={{
                    width: 40, height: 40,
                    border: '4px solid rgba(255,255,255,0.1)',
                    borderTop: '4px solid #fc4c02',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite'
                }} />
            )}
            <p style={{ fontSize: '1.1rem', color: isError ? '#f87171' : '#e2e8f0' }}>
                {message}
            </p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
};

export default StravaCallback;
