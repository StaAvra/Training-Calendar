import React, { useEffect, useState } from 'react';
import { useUser } from '../context/UserContext';
import { Save, User, Activity, Heart, Link as LinkIcon, CheckCircle, Watch, LogOut } from 'lucide-react';
import { calculateZones } from '../utils/analysis';
import { testProxyConnection } from '../utils/stravaApi';
import { garminLogin, garminLogout } from '../utils/garminApi';
import { db } from '../utils/db';
import styles from './Profile.module.css';

const Profile = () => {
    const { currentUser, updateProfile } = useUser();
    const [formData, setFormData] = useState({
        ftp: 250,
        weight: 70,
        maxHr: 190,
        lthr: 170
    });
    const [stravaConnected, setStravaConnected] = useState(false);
    const [garminConnected, setGarminConnected] = useState(false);
    const [garminEmail, setGarminEmail] = useState('');
    const [garminPassword, setGarminPassword] = useState('');
    const [garminLoading, setGarminLoading] = useState(false);
    const [proxyUrl, setProxyUrl] = useState('');
    const [proxyInput, setProxyInput] = useState('');
    const [status, setStatus] = useState('');

    useEffect(() => {
        if (currentUser?.profile) {
            setFormData(currentUser.profile);
        }

        const checkStravaStatus = async () => {
            const token = await db.getSettings('strava_access_token');
            if (token) setStravaConnected(true);
            
            // Check Garmin status
            const garminConn = await db.getSettings('garmin_connected');
            if (garminConn) setGarminConnected(true);

            // Load proxy URL
            const savedProxy = await db.getSettings('proxy_url');
            const defaultProxy = savedProxy || 'http://localhost:3000';
            setProxyUrl(defaultProxy);
            setProxyInput(defaultProxy);
        };
        checkStravaStatus();

        if (window.electron && window.electron.onStravaAuth) {
            window.electron.onStravaAuth(async (tokens) => {
                try {
                    await db.saveSettings('strava_access_token', tokens.access_token);
                    await db.saveSettings('strava_refresh_token', tokens.refresh_token);
                    await db.saveSettings('strava_expires_at', tokens.expires_at);
                    if (tokens.athlete_id) {
                        await db.saveSettings('strava_athlete_id', tokens.athlete_id);
                    }
                    setStravaConnected(true);
                    setStatus('Successfully connected to Strava!');
                    setTimeout(() => setStatus(''), 4000);
                } catch(err) {
                    console.error("Failed to save Strava tokens:", err);
                    setStatus('Failed to save Strava connection.');
                }
            });
        }
    }, [currentUser]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: Number(value)
        }));
    };

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            await updateProfile(formData);
            setStatus('Saved successfully!');
            setTimeout(() => setStatus(''), 3000);
        } catch (err) {
            console.error(err);
            setStatus('Failed to save.');
        }
    };

    const handleProxyUrlSave = async () => {
        try {
            if (!proxyInput.startsWith('http')) {
                setStatus('Proxy URL must start with http:// or https://');
                return;
            }
            await db.saveSettings('proxy_url', proxyInput);
            setProxyUrl(proxyInput);
            setStatus('Proxy URL saved! It will be used for future Strava syncs.');
            setTimeout(() => setStatus(''), 4000);
        } catch (err) {
            console.error(err);
            setStatus('Failed to save proxy URL.');
        }
    };

    const handleTestConnection = async () => {
        setStatus('Testing connection...');
        try {
            const result = await testProxyConnection();
            if (result.ok) {
                setStatus(`✓ Backend is reachable at ${result.url}`);
            } else {
                setStatus(`✗ Cannot reach backend at ${result.url}: ${result.error || `HTTP ${result.status}`}`);
            }
            setTimeout(() => setStatus(''), 5000);
        } catch (err) {
            console.error(err);
            setStatus(`Connection test failed: ${err.message}`);
        }
    };

    const handleGarminLogin = async () => {
        if (!garminEmail || !garminPassword) {
            setStatus('Please enter your Garmin email and password.');
            return;
        }
        setGarminLoading(true);
        setStatus('Connecting to Garmin...');
        try {
            await garminLogin(garminEmail, garminPassword);
            setGarminConnected(true);
            setGarminPassword(''); // Clear password from memory
            setStatus('✓ Garmin connected! Sleep & HRV data will auto-fill in daily metrics.');
            setTimeout(() => setStatus(''), 5000);
        } catch (err) {
            console.error('Garmin login failed:', err);
            setStatus(`Garmin login failed: ${err.message}`);
        } finally {
            setGarminLoading(false);
        }
    };

    const handleGarminLogout = async () => {
        await garminLogout();
        setGarminConnected(false);
        setStatus('Garmin disconnected.');
        setTimeout(() => setStatus(''), 3000);
    };

    return (
        <div className="container" style={{ maxWidth: '800px' }}>
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Profile & Settings</h1>
                <p className="text-muted">Configure your physical metrics for accurate analysis.</p>
            </header>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-xl)' }}>

                {/* Settings Form */}
                <div>
                    <form onSubmit={handleSave} className={styles.form}>
                        <div className="card">
                            <h3 className="text-lg" style={{ marginBottom: 'var(--space-lg)' }}>Metrics</h3>

                            <div className={styles.inputGroup}>
                                <label>FTP (Functional Threshold Power)</label>
                                <div className={styles.inputWrapper}>
                                    <Activity size={16} />
                                    <input
                                        type="number"
                                        name="ftp"
                                        value={formData.ftp}
                                        onChange={handleChange}
                                    />
                                    <span>W</span>
                                </div>
                                <small className="text-muted">Used to calculate your training zones.</small>
                            </div>

                            <div className={styles.inputGroup}>
                                <label>Weight</label>
                                <div className={styles.inputWrapper}>
                                    <User size={16} />
                                    <input
                                        type="number"
                                        name="weight"
                                        value={formData.weight}
                                        onChange={handleChange}
                                    />
                                    <span>kg</span>
                                </div>
                            </div>

                            <div className={styles.inputGroup}>
                                <label>Max Heart Rate</label>
                                <div className={styles.inputWrapper}>
                                    <Heart size={16} />
                                    <input
                                        type="number"
                                        name="maxHr"
                                        value={formData.maxHr}
                                        onChange={handleChange}
                                    />
                                    <span>bpm</span>
                                </div>
                            </div>

                            <div className={styles.inputGroup}>
                                <label>Lactate Threshold HR</label>
                                <div className={styles.inputWrapper}>
                                    <Heart size={16} />
                                    <input
                                        type="number"
                                        name="lthr"
                                        value={formData.lthr}
                                        onChange={handleChange}
                                    />
                                    <span>bpm</span>
                                </div>
                            </div>

                            <button type="submit" className={styles.saveBtn}>
                                <Save size={18} />
                                Save Settings
                            </button>
                            {status && !status.includes('Strava') && <p className={styles.status}>{status}</p>}
                        </div>
                    </form>

                    <div className="card" style={{ marginTop: 'var(--space-xl)' }}>
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Integrations</h3>
                        <div className={styles.integrationRow}>
                            <div>
                                <h4 style={{ margin: 0 }}>Strava</h4>
                                <p className="text-muted" style={{ fontSize: '0.85rem', margin: '4px 0 0 0' }}>Sync activities and streams automatically.</p>
                            </div>
                            {stravaConnected ? (
                                <div className={styles.connectedBadge}>
                                    <CheckCircle size={16} /> Connected
                                </div>
                            ) : (
                                <a href={`${proxyUrl}/api/strava/login`} target="_blank" rel="noreferrer" className={styles.connectBtn}>
                                    <LinkIcon size={16} /> Connect
                                </a>
                            )}
                        </div>
                        {status && status.includes('Strava') && <p className={styles.status} style={{marginTop: 'var(--space-sm)'}}>{status}</p>}
                    </div>

                    <div className="card" style={{ marginTop: 'var(--space-xl)' }}>
                        <div className={styles.integrationRow}>
                            <div>
                                <h4 style={{ margin: 0 }}>Garmin Connect</h4>
                                <p className="text-muted" style={{ fontSize: '0.85rem', margin: '4px 0 0 0' }}>Sync sleep, HRV, and resting heart rate.</p>
                            </div>
                            {garminConnected ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div className={styles.connectedBadge}>
                                        <CheckCircle size={16} /> Connected
                                    </div>
                                    <button
                                        onClick={handleGarminLogout}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '4px',
                                            padding: '4px 10px', background: 'transparent',
                                            border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                                            color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem'
                                        }}
                                    >
                                        <LogOut size={14} /> Disconnect
                                    </button>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '8px' }}>
                                    <input
                                        type="email"
                                        placeholder="Garmin email"
                                        value={garminEmail}
                                        onChange={(e) => setGarminEmail(e.target.value)}
                                        style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                                    />
                                    <input
                                        type="password"
                                        placeholder="Garmin password"
                                        value={garminPassword}
                                        onChange={(e) => setGarminPassword(e.target.value)}
                                        style={{ padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                                    />
                                    <button
                                        onClick={handleGarminLogin}
                                        disabled={garminLoading}
                                        style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                            padding: '6px 12px', background: '#007dc3', color: 'white',
                                            border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                            fontSize: '0.85rem', fontWeight: 500, opacity: garminLoading ? 0.7 : 1
                                        }}
                                    >
                                        <Watch size={16} /> {garminLoading ? 'Connecting...' : 'Connect'}
                                    </button>
                                </div>
                            )}
                        </div>
                        {status && status.includes('Garmin') && <p className={styles.status} style={{marginTop: 'var(--space-sm)'}}>{status}</p>}
                    </div>

                    <div className="card" style={{ marginTop: 'var(--space-xl)' }}>
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Backend Configuration</h3>
                        <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: 'var(--space-md)' }}>
                            Configure the backend URL for Strava syncing. This is automatically detected, but can be manually set if running on a different machine.
                        </p>
                        <div className={styles.inputGroup}>
                            <label>Backend/Proxy URL</label>
                            <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                                <input
                                    type="text"
                                    value={proxyInput}
                                    onChange={(e) => setProxyInput(e.target.value)}
                                    placeholder="e.g., http://localhost:3000 or https://your-backend.vercel.app"
                                    style={{ flex: 1, padding: 'var(--space-xs) var(--space-sm)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                />
                                <button
                                    onClick={handleProxyUrlSave}
                                    style={{ 
                                        padding: 'var(--space-xs) var(--space-md)', 
                                        background: 'var(--accent-primary)', 
                                        color: 'white', 
                                        border: 'none', 
                                        borderRadius: 'var(--radius-sm)',
                                        cursor: 'pointer',
                                        fontSize: '0.875rem',
                                        fontWeight: 500,
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    Save
                                </button>
                                <button
                                    onClick={handleTestConnection}
                                    style={{ 
                                        padding: 'var(--space-xs) var(--space-md)', 
                                        background: 'var(--text-accent)', 
                                        color: 'white', 
                                        border: 'none', 
                                        borderRadius: 'var(--radius-sm)',
                                        cursor: 'pointer',
                                        fontSize: '0.875rem',
                                        fontWeight: 500,
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    Test
                                </button>
                            </div>
                            <small className="text-muted" style={{ marginTop: 'var(--space-xs)' }}>Current URL: <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '3px' }}>{proxyUrl}</code></small>
                        </div>
                    </div>
                </div>

                {/* Zones Preview */}
                <div>
                    <div className="card">
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Power Zones</h3>
                        <p className="text-muted" style={{ marginBottom: 'var(--space-lg)' }}>Based on FTP: <strong>{formData.ftp}W</strong></p>

                        <div className={styles.zonesList}>
                            {calculateZones(formData.ftp).map((zone, i) => (
                                <div key={i} className={styles.zoneItem}>
                                    <div className={styles.zoneColor} style={{ backgroundColor: zone.color }}></div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 500 }}>{zone.name}</div>
                                    </div>
                                    <div style={{ fontFamily: 'monospace', color: 'var(--text-accent)' }}>
                                        {zone.range}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
};

export default Profile;
