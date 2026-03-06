import React, { useEffect, useState } from 'react';
import { useUser } from '../context/UserContext';
import { Save, User, Activity, Heart, Link as LinkIcon, CheckCircle } from 'lucide-react';
import { calculateZones } from '../utils/analysis';
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

    const [status, setStatus] = useState('');

    useEffect(() => {
        if (currentUser?.profile) {
            setFormData(currentUser.profile);
        }

        const checkStravaStatus = async () => {
            const token = await db.getSettings('strava_access_token');
            if (token) setStravaConnected(true);
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
                                // For local development, proxy runs on 3000
                                <a href="http://localhost:3000/api/strava/login" target="_blank" rel="noreferrer" className={styles.connectBtn}>
                                    <LinkIcon size={16} /> Connect
                                </a>
                            )}
                        </div>
                        {status && status.includes('Strava') && <p className={styles.status} style={{marginTop: 'var(--space-sm)'}}>{status}</p>}
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
