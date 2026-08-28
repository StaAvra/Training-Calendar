import React, { useEffect, useState } from 'react';
import { useUser } from '../context/UserContext';
import { Save, User, Activity, Heart, Link as LinkIcon, CheckCircle, Watch, LogOut, Calendar, RefreshCw } from 'lucide-react';
import { calculateZones, buildCurveFromStreams } from '../utils/analysis';
import { testProxyConnection, fetchStravaActivities, fetchStravaStreams } from '../utils/stravaApi';
import { garminLogin, garminLogout, fetchGarminActivities, fetchGarminActivityStreams } from '../utils/garminApi';
import { beginSync, endSync, normalizeSyncMode, getStravaSyncWindow as buildStravaSyncWindow, getGarminSyncWindow as buildGarminSyncWindow, isDuplicateWorkout } from '../utils/syncService';
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
    const [garminSyncing, setGarminSyncing] = useState(false);
    const [garminSyncMessage, setGarminSyncMessage] = useState('');
    const [garminSyncMode, setGarminSyncMode] = useState('incremental'); // 'incremental' | 'all' | 'custom' | 'fromDate'
    const [garminSyncFrom, setGarminSyncFrom] = useState('');
    const [garminSyncTo, setGarminSyncTo] = useState('');
    const [proxyUrl, setProxyUrl] = useState('');
    const [proxyInput, setProxyInput] = useState('');
    const [status, setStatus] = useState('');
    const [syncMode, setSyncMode] = useState('incremental'); // 'incremental' | 'all' | 'custom' | 'fromDate'
    const [syncFrom, setSyncFrom] = useState('');
    const [syncTo, setSyncTo] = useState('');
    const [syncing, setSyncing] = useState(false);
    const [syncMessage, setSyncMessage] = useState('');

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

            // Load sync period settings
            const savedSyncMode = await db.getSettings('sync_mode');
            if (savedSyncMode) setSyncMode(normalizeSyncMode(savedSyncMode));
            const savedSyncFrom = await db.getSettings('sync_from');
            if (savedSyncFrom) setSyncFrom(savedSyncFrom);
            const savedSyncTo = await db.getSettings('sync_to');
            if (savedSyncTo) setSyncTo(savedSyncTo);

            const savedGarminSyncMode = await db.getSettings('garmin_sync_mode');
            if (savedGarminSyncMode) setGarminSyncMode(normalizeSyncMode(savedGarminSyncMode));
            const savedGarminSyncFrom = await db.getSettings('garmin_sync_from');
            if (savedGarminSyncFrom) setGarminSyncFrom(savedGarminSyncFrom);
            const savedGarminSyncTo = await db.getSettings('garmin_sync_to');
            if (savedGarminSyncTo) setGarminSyncTo(savedGarminSyncTo);
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

    const handleGarminSyncActivities = async () => {
        if (!currentUser || !garminConnected) return;
        if (!beginSync('garmin')) {
            setGarminSyncMessage('Garmin sync is already running.');
            return;
        }
        setGarminSyncing(true);
        setGarminSyncMessage('Fetching Garmin activities...');
        try {
            const activities = await fetchGarminActivities(200);
            const { fromTs, toTs } = await getGarminSyncWindow();
            const filteredActivities = (activities || []).filter(activity => {
                const startTs = new Date(activity.start_time).getTime();
                if (!Number.isFinite(startTs)) return false;
                if (fromTs && startTs < fromTs) return false;
                if (toTs && startTs > toTs) return false;
                return true;
            });

            if (!filteredActivities || filteredActivities.length === 0) {
                setGarminSyncMessage('No cycling activities found on Garmin.');
                setGarminSyncing(false);
                setTimeout(() => setGarminSyncMessage(''), 4000);
                return;
            }

            setGarminSyncMessage(`Found ${filteredActivities.length} cycling activities. Importing...`);
            const existingWorkouts = await db.getWorkouts(currentUser.id);
            let newCount = 0;
            let skippedCount = 0;
            let backfilledCount = 0;

            for (const activity of filteredActivities) {
                // Deduplication: check garmin_id, strava_id, or matching start_time
                const existingWorkout = existingWorkouts.find(w =>
                    isDuplicateWorkout(w, activity)
                );

                if (existingWorkout) {
                    if (!Array.isArray(existingWorkout.streams) || existingWorkout.streams.length === 0) {
                        try {
                            const streams = await fetchGarminActivityStreams(activity.garmin_id);
                            if (streams.length > 0) {
                                const powerValues = streams.map(s => Number(s.power)).filter(v => Number.isFinite(v) && v > 0);
                                const hrValues = streams.map(s => Number(s.heart_rate)).filter(v => Number.isFinite(v) && v > 0);

                                await db.updateWorkout(existingWorkout.id, {
                                    streams,
                                    avg_power: existingWorkout.avg_power || (powerValues.length ? Math.round(powerValues.reduce((a, b) => a + b, 0) / powerValues.length) : 0),
                                    max_power: existingWorkout.max_power || (powerValues.length ? Math.max(...powerValues) : 0),
                                    avg_heart_rate: existingWorkout.avg_heart_rate || (hrValues.length ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length) : 0),
                                    max_heart_rate: existingWorkout.max_heart_rate || (hrValues.length ? Math.max(...hrValues) : 0),
                                    power_curve: buildCurveFromStreams(streams, 'power') || existingWorkout.power_curve || null,
                                    heart_rate_curve: buildCurveFromStreams(streams, 'heart_rate') || existingWorkout.heart_rate_curve || null,
                                });
                                backfilledCount++;
                            }
                        } catch (streamErr) {
                            console.warn(`Could not fetch streams for Garmin activity ${activity.garmin_id}:`, streamErr.message);
                        }
                    }

                    skippedCount++;
                    continue;
                }

                let streams = [];
                try {
                    streams = await fetchGarminActivityStreams(activity.garmin_id);
                } catch (streamErr) {
                    console.warn(`Could not fetch streams for Garmin activity ${activity.garmin_id}:`, streamErr.message);
                }

                const powerValues = streams.map(s => Number(s.power)).filter(v => Number.isFinite(v) && v > 0);
                const hrValues = streams.map(s => Number(s.heart_rate)).filter(v => Number.isFinite(v) && v > 0);

                const upsertResult = await db.upsertWorkout({
                    userId: currentUser.id,
                    title: activity.name,
                    date: new Date(activity.start_time).toISOString(),
                    source: 'garmin_api',
                    garmin_id: activity.garmin_id,
                    imported_at: new Date().toISOString(),
                    start_time: new Date(activity.start_time).toISOString(),
                    total_elapsed_time: activity.total_elapsed_time,
                    total_distance: activity.total_distance,
                    avg_speed: activity.avg_speed,
                    avg_power: activity.avg_power || (powerValues.length ? Math.round(powerValues.reduce((a, b) => a + b, 0) / powerValues.length) : 0),
                    max_power: activity.max_power || (powerValues.length ? Math.max(...powerValues) : 0),
                    avg_heart_rate: activity.avg_heart_rate || (hrValues.length ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length) : 0),
                    max_heart_rate: activity.max_heart_rate || (hrValues.length ? Math.max(...hrValues) : 0),
                    normalized_power: activity.normalized_power || 0,
                    avg_cadence: activity.avg_cadence || 0,
                    calories: activity.calories || 0,
                    elevation_gain: activity.elevation_gain || 0,
                    training_stress_score: activity.training_stress_score || null,
                    intensity_factor: activity.intensity_factor || null,
                    power_curve: activity.power_curve || buildCurveFromStreams(streams, 'power'),
                    heart_rate_curve: activity.heart_rate_curve || buildCurveFromStreams(streams, 'heart_rate'),
                    streams
                });
                if (upsertResult.inserted) {
                    newCount++;
                }
            }

            await db.saveSettings('garmin_last_sync', Math.floor(Date.now() / 1000));

            setGarminSyncMessage(`Synced ${newCount} new activities. Backfilled ${backfilledCount} existing rides with streams. (${skippedCount} duplicates skipped)`);
            setTimeout(() => setGarminSyncMessage(''), 5000);
        } catch (err) {
            console.error('Garmin activity sync error:', err);
            setGarminSyncMessage(`Sync failed: ${err.message}`);
        } finally {
            endSync('garmin');
            setGarminSyncing(false);
        }
    };

    const handleSyncModeChange = async (mode) => {
        const normalizedMode = normalizeSyncMode(mode);
        setSyncMode(normalizedMode);
        await db.saveSettings('sync_mode', normalizedMode);
        if (normalizedMode === 'incremental') {
            await db.saveSettings('sync_from', '');
            await db.saveSettings('sync_to', '');
            setSyncFrom('');
            setSyncTo('');
        } else if (normalizedMode === 'all') {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const fromStr = sixMonthsAgo.toISOString().split('T')[0];
            await db.saveSettings('sync_from', fromStr);
            await db.saveSettings('sync_to', '');
            setSyncFrom(fromStr);
            setSyncTo('');
        } else if (normalizedMode === 'fromDate') {
            await db.saveSettings('sync_to', '');
            setSyncTo('');
        }
    };

    const handleCustomDateChange = async (field, value) => {
        if (field === 'from') {
            setSyncFrom(value);
            await db.saveSettings('sync_from', value);
        } else {
            setSyncTo(value);
            await db.saveSettings('sync_to', value);
        }
    };

    const handleGarminSyncModeChange = async (mode) => {
        const normalizedMode = normalizeSyncMode(mode);
        setGarminSyncMode(normalizedMode);
        await db.saveSettings('garmin_sync_mode', normalizedMode);
        if (normalizedMode === 'incremental') {
            await db.saveSettings('garmin_sync_from', '');
            await db.saveSettings('garmin_sync_to', '');
            setGarminSyncFrom('');
            setGarminSyncTo('');
        } else if (normalizedMode === 'all') {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const fromStr = sixMonthsAgo.toISOString().split('T')[0];
            await db.saveSettings('garmin_sync_from', fromStr);
            await db.saveSettings('garmin_sync_to', '');
            setGarminSyncFrom(fromStr);
            setGarminSyncTo('');
        } else if (normalizedMode === 'fromDate') {
            await db.saveSettings('garmin_sync_to', '');
            setGarminSyncTo('');
        }
    };

    const handleGarminCustomDateChange = async (field, value) => {
        if (field === 'from') {
            setGarminSyncFrom(value);
            await db.saveSettings('garmin_sync_from', value);
        } else {
            setGarminSyncTo(value);
            await db.saveSettings('garmin_sync_to', value);
        }
    };

    const getGarminSyncWindow = async () => {
        const lastSync = await db.getSettings('garmin_last_sync');
        return buildGarminSyncWindow({
            mode: garminSyncMode,
            fromDate: garminSyncFrom,
            toDate: garminSyncTo,
            lastSyncEpoch: lastSync,
        });
    };

    const handleSyncNow = async () => {
        if (!currentUser) return;
        if (!stravaConnected) {
            setStatus('Connect to Strava first.');
            setTimeout(() => setStatus(''), 3000);
            return;
        }
        if (!beginSync('strava')) {
            setSyncMessage('Strava sync is already running.');
            return;
        }
        setSyncing(true);
        setSyncMessage('Testing backend...');
        try {
            const connTest = await testProxyConnection();
            if (!connTest.ok) {
                setSyncMessage(`Cannot reach backend: ${connTest.error || connTest.status}`);
                setSyncing(false);
                return;
            }
            setSyncMessage('Fetching activities...');

            const lastSync = await db.getSettings('strava_last_sync');
            const { afterEpoch, beforeEpoch } = buildStravaSyncWindow({
                mode: syncMode,
                fromDate: syncFrom,
                toDate: syncTo,
                lastSyncEpoch: lastSync,
            });

            const activities = await fetchStravaActivities(afterEpoch, beforeEpoch);
            const cyclingTypes = ['Ride', 'VirtualRide', 'EBikeRide', 'Handcycle', 'Velomobile'];
            const rides = (activities || []).filter(a => cyclingTypes.includes(a.type));

            if (rides.length === 0) {
                setSyncMessage('No new cycling activities found.');
                await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
                setSyncing(false);
                setTimeout(() => setSyncMessage(''), 4000);
                return;
            }

            let newCount = 0;
            const existingWorkouts = await db.getWorkouts(currentUser.id);

            for (const activity of rides) {
                const isDuplicate = existingWorkouts.some(w =>
                    isDuplicateWorkout(w, {
                        strava_id: activity.id,
                        start_time: activity.start_date,
                    })
                );
                if (isDuplicate) continue;

                setSyncMessage(`Fetching streams: ${activity.name}...`);
                const streamSet = await fetchStravaStreams(activity.id);
                let formattedStreams = [];
                let avgPower = 0, maxPower = 0;

                if (streamSet && streamSet.length > 0) {
                    const streamsData = {};
                    streamSet.forEach(s => { streamsData[s.type] = s.data; });
                    const timeArr = streamsData.time || [];
                    for (let i = 0; i < timeArr.length; i++) {
                        formattedStreams.push({
                            time: timeArr[i],
                            power: streamsData.watts?.[i] ?? null,
                            heart_rate: streamsData.heartrate?.[i] ?? null,
                            cadence: streamsData.cadence?.[i] ?? null,
                            speed: streamsData.velocity_smooth?.[i] ?? null,
                            distance: streamsData.distance?.[i] ?? null
                        });
                    }
                    avgPower = streamsData.watts ? streamsData.watts.reduce((a, b) => a + b, 0) / streamsData.watts.length : 0;
                    maxPower = streamsData.watts ? Math.max(...streamsData.watts) : 0;
                }

                const upsertResult = await db.upsertWorkout({
                    userId: currentUser.id,
                    title: activity.name,
                    date: new Date(activity.start_date).toISOString(),
                    source: 'strava_api',
                    strava_id: activity.id,
                    imported_at: new Date().toISOString(),
                    start_time: new Date(activity.start_date).toISOString(),
                    total_elapsed_time: activity.elapsed_time,
                    total_distance: activity.distance,
                    avg_speed: activity.average_speed,
                    avg_power: activity.average_watts || avgPower || 0,
                    max_power: activity.max_watts || maxPower || 0,
                    avg_heart_rate: activity.average_heartrate || 0,
                    max_heart_rate: activity.max_heartrate || 0,
                    normalized_power: activity.weighted_average_watts || activity.average_watts || 0,
                    total_work: activity.kilojoules ? activity.kilojoules * 1000 : 0,
                    power_curve: buildCurveFromStreams(formattedStreams, 'power'),
                    heart_rate_curve: buildCurveFromStreams(formattedStreams, 'heart_rate'),
                    streams: formattedStreams
                });
                if (upsertResult.inserted) {
                    newCount++;
                }
            }

            await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
            setSyncMessage(`Synced ${newCount} new activities!`);
            setTimeout(() => setSyncMessage(''), 5000);
        } catch (err) {
            console.error('Sync error:', err);
            setSyncMessage(`Sync failed: ${err.message}`);
        } finally {
            endSync('strava');
            setSyncing(false);
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

                        {/* Sync Period Selector */}
                        <div style={{ marginBottom: 'var(--space-lg)', padding: 'var(--space-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: 'var(--space-sm)' }}>
                                <Calendar size={16} color="var(--text-secondary)" />
                                <span className="text-sm" style={{ fontWeight: 600 }}>Sync Period</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                    <input type="radio" name="syncMode" value="incremental" checked={syncMode === 'incremental'} onChange={() => handleSyncModeChange('incremental')} />
                                    Incremental (since last sync)
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                    <input type="radio" name="syncMode" value="all" checked={syncMode === 'all'} onChange={() => handleSyncModeChange('all')} />
                                    Backfill last 6 months
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                    <input type="radio" name="syncMode" value="custom" checked={syncMode === 'custom'} onChange={() => handleSyncModeChange('custom')} />
                                    Custom date range
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                    <input type="radio" name="syncMode" value="fromDate" checked={syncMode === 'fromDate'} onChange={() => handleSyncModeChange('fromDate')} />
                                    From date onward
                                </label>
                                {syncMode === 'custom' && (
                                    <div style={{ display: 'flex', gap: '8px', marginLeft: '24px', marginTop: '4px' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                            <small className="text-muted">From</small>
                                            <input
                                                type="date"
                                                value={syncFrom}
                                                max={new Date().toISOString().split('T')[0]}
                                                min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                onChange={(e) => handleCustomDateChange('from', e.target.value)}
                                                style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                            <small className="text-muted">To</small>
                                            <input
                                                type="date"
                                                value={syncTo}
                                                max={new Date().toISOString().split('T')[0]}
                                                min={syncFrom || (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                onChange={(e) => handleCustomDateChange('to', e.target.value)}
                                                style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                            />
                                        </div>
                                    </div>
                                )}
                                {syncMode === 'fromDate' && (
                                    <div style={{ display: 'flex', gap: '8px', marginLeft: '24px', marginTop: '4px' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                            <small className="text-muted">Starting from</small>
                                            <input
                                                type="date"
                                                value={syncFrom}
                                                max={new Date().toISOString().split('T')[0]}
                                                min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                onChange={(e) => handleCustomDateChange('from', e.target.value)}
                                                style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={handleSyncNow}
                                disabled={syncing || !stravaConnected}
                                style={{
                                    marginTop: 'var(--space-md)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                    width: '100%', padding: '8px 16px',
                                    background: stravaConnected ? '#fc4c02' : 'var(--bg-tertiary)',
                                    color: stravaConnected ? 'white' : 'var(--text-secondary)',
                                    border: 'none', borderRadius: 'var(--radius-sm)',
                                    cursor: stravaConnected ? 'pointer' : 'not-allowed',
                                    fontSize: '0.85rem', fontWeight: 600,
                                    opacity: syncing ? 0.7 : 1
                                }}
                            >
                                <RefreshCw size={14} className={syncing ? styles.spinning : ''} />
                                {syncing ? 'Syncing...' : 'Sync Now'}
                            </button>
                            {syncMessage && <p className="text-sm" style={{ marginTop: '6px', color: syncMessage.includes('failed') ? 'var(--accent-danger)' : 'var(--text-secondary)' }}>{syncMessage}</p>}
                        </div>

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
                                <p className="text-muted" style={{ fontSize: '0.85rem', margin: '4px 0 0 0' }}>Sync activities, sleep, HRV, and resting heart rate.</p>
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
                        {garminConnected && (
                            <div style={{ marginTop: 'var(--space-md)', padding: 'var(--space-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: 'var(--space-sm)' }}>
                                    <Activity size={16} color="var(--text-secondary)" />
                                    <span className="text-sm" style={{ fontWeight: 600 }}>Garmin Activities</span>
                                </div>
                                <div style={{ marginBottom: 'var(--space-sm)' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                            <input type="radio" name="garminSyncMode" value="incremental" checked={garminSyncMode === 'incremental'} onChange={() => handleGarminSyncModeChange('incremental')} />
                                            Incremental (since last sync)
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                            <input type="radio" name="garminSyncMode" value="all" checked={garminSyncMode === 'all'} onChange={() => handleGarminSyncModeChange('all')} />
                                            Backfill last 6 months
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                            <input type="radio" name="garminSyncMode" value="custom" checked={garminSyncMode === 'custom'} onChange={() => handleGarminSyncModeChange('custom')} />
                                            Custom date range
                                        </label>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                                            <input type="radio" name="garminSyncMode" value="fromDate" checked={garminSyncMode === 'fromDate'} onChange={() => handleGarminSyncModeChange('fromDate')} />
                                            From date onward
                                        </label>
                                        {garminSyncMode === 'custom' && (
                                            <div style={{ display: 'flex', gap: '8px', marginLeft: '24px', marginTop: '4px' }}>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    <small className="text-muted">From</small>
                                                    <input
                                                        type="date"
                                                        value={garminSyncFrom}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleGarminCustomDateChange('from', e.target.value)}
                                                        style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                                    />
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    <small className="text-muted">To</small>
                                                    <input
                                                        type="date"
                                                        value={garminSyncTo}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={garminSyncFrom || (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleGarminCustomDateChange('to', e.target.value)}
                                                        style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        {garminSyncMode === 'fromDate' && (
                                            <div style={{ display: 'flex', gap: '8px', marginLeft: '24px', marginTop: '4px' }}>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    <small className="text-muted">Starting from</small>
                                                    <input
                                                        type="date"
                                                        value={garminSyncFrom}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleGarminCustomDateChange('from', e.target.value)}
                                                        style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <p className="text-muted" style={{ fontSize: '0.8rem', marginBottom: 'var(--space-sm)' }}>
                                    Import cycling activities with HR, power, speed, and distance. Duplicates with Strava are automatically detected and skipped.
                                </p>
                                <button
                                    onClick={handleGarminSyncActivities}
                                    disabled={garminSyncing}
                                    style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                        width: '100%', padding: '8px 16px',
                                        background: '#007dc3',
                                        color: 'white',
                                        border: 'none', borderRadius: 'var(--radius-sm)',
                                        cursor: 'pointer',
                                        fontSize: '0.85rem', fontWeight: 600,
                                        opacity: garminSyncing ? 0.7 : 1
                                    }}
                                >
                                    <RefreshCw size={14} className={garminSyncing ? styles.spinning : ''} />
                                    {garminSyncing ? 'Syncing...' : 'Sync Garmin Activities'}
                                </button>
                                {garminSyncMessage && <p className="text-sm" style={{ marginTop: '6px', color: garminSyncMessage.includes('failed') ? 'var(--accent-danger)' : 'var(--text-secondary)' }}>{garminSyncMessage}</p>}
                            </div>
                        )}
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
