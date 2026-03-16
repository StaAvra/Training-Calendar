import React, { useEffect, useState, useRef } from 'react';
import { startOfWeek, endOfWeek, subDays, isWithinInterval, startOfDay } from 'date-fns';
import { useUser } from '../context/UserContext';
import { db } from '../utils/db';
import { calculateCriticalPower, calculatePhenotype, calculateSessionDerivedFtp } from '../utils/analysis';
import { fetchStravaActivities, fetchStravaStreams } from '../utils/stravaApi';
import { fetchGarminActivities } from '../utils/garminApi';
import FileDropzone from '../components/FileDropzone';
import WorkoutPill from '../components/WorkoutPill';
import Modal from '../components/Modal';
import RideDetailsModal from '../components/RideDetailsModal';
import { Activity, Clock, Zap, RefreshCw, Watch } from 'lucide-react';

const Dashboard = () => {
    const { currentUser } = useUser();
    const [workouts, setWorkouts] = useState([]);
    const [stats, setStats] = useState({ count: 0, distance: 0, duration: 0 });
    const [performance, setPerformance] = useState({ cp: null, ae: null, phenotype: null, sessionDerivedFtp: null });
    const [selectedWorkout, setSelectedWorkout] = useState(null);
    const [stravaConnected, setStravaConnected] = useState(false);
    const [garminConnected, setGarminConnected] = useState(false);
    const [stravaSyncing, setStravaSyncing] = useState(false);
    const [stravaSyncMsg, setStravaSyncMsg] = useState('');
    const [garminSyncing, setGarminSyncing] = useState(false);
    const [garminSyncMsg, setGarminSyncMsg] = useState('');
    const autoSyncRan = useRef(false);

    const loadData = async () => {
        if (!currentUser) return;
        const data = await db.getWorkouts(currentUser.id);
        const sorted = data.sort((a, b) => new Date(b.date) - new Date(a.date));
        setWorkouts(sorted);

        // 1. Calculate Weekly Stats (Last 7 Days)
        const sevenDaysAgo = subDays(new Date(), 7);
        const weeklyWorkouts = sorted.filter(w => new Date(w.date) >= sevenDaysAgo);

        const totalDist = weeklyWorkouts.reduce((acc, curr) => acc + (curr.total_distance || 0), 0);
        const totalTime = weeklyWorkouts.reduce((acc, curr) => acc + (curr.total_elapsed_time || 0), 0);

        setStats({
            count: weeklyWorkouts.length,
            distance: (totalDist / 1000).toFixed(1), // km
            duration: (totalTime / 3600).toFixed(1) // hours
        });

        // 2. Performance Metrics (Last 6 Weeks)
        const sixWeeksAgo = startOfDay(subDays(new Date(), 42));
        const recentWorkouts = sorted.filter(w => new Date(w.date) >= sixWeeksAgo);

        // CP Logic
        const curveBests = {
            duration_5s: 0, duration_1m: 0, duration_5m: 0, duration_20m: 0, duration_3m: 0 // Adding 3m for CP
        };
        recentWorkouts.forEach(w => {
            if (w.power_curve) {
                Object.keys(curveBests).forEach(k => {
                    if (w.power_curve[k] > curveBests[k]) curveBests[k] = w.power_curve[k];
                });
            }
        });

        const cp = calculateCriticalPower(curveBests);
        const phenotype = calculatePhenotype(curveBests, currentUser.profile?.weight || 70);
        const sessionDerivedFtp = calculateSessionDerivedFtp(recentWorkouts);

        // AE Logic (NP / HR for qualifying rides) - Show most recent
        const qualifyingRides = recentWorkouts
            .filter(w => {
                const ifVal = w.intensity_factor || ((w.normalized_power || w.avg_power) / (currentUser.profile?.ftp || 250));
                return ifVal <= 0.75 && (w.total_elapsed_time / 60) >= 30 && w.avg_heart_rate > 0;
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date)); // Sort by date descending

        const ae = qualifyingRides.length > 0
            ? ((qualifyingRides[0].normalized_power || qualifyingRides[0].avg_power) / qualifyingRides[0].avg_heart_rate).toFixed(2)
            : null;

        setPerformance({ cp, ae, phenotype, sessionDerivedFtp });
    };

    // Returns true if two timestamps are within 60 seconds of each other
    const isSameStartTime = (t1, t2) => {
        const a = new Date(t1).getTime();
        const b = new Date(t2).getTime();
        if (isNaN(a) || isNaN(b)) return false;
        return Math.abs(a - b) < 60000;
    };

    const syncStrava = async (silent = false) => {
        const token = await db.getSettings('strava_access_token');
        if (!token) return;
        if (!silent) setStravaSyncing(true);
        setStravaSyncMsg(silent ? '' : 'Syncing Strava...');
        try {
            let lastSync = await db.getSettings('strava_last_sync');
            if (!lastSync) lastSync = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
            const activities = await fetchStravaActivities(lastSync);
            const cyclingTypes = ['Ride', 'VirtualRide', 'EBikeRide', 'Handcycle', 'Velomobile'];
            const rides = (activities || []).filter(a => cyclingTypes.includes(a.type));
            if (rides.length === 0) {
                await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
                if (!silent) setStravaSyncMsg('No new Strava rides.');
                return;
            }
            const existingWorkouts = await db.getWorkouts(currentUser.id);
            let newCount = 0;
            for (const activity of rides) {
                const isDup = existingWorkouts.some(w =>
                    w.strava_id === activity.id ||
                    isSameStartTime(w.start_time, activity.start_date)
                );
                if (isDup) continue;
                const streamSet = await fetchStravaStreams(activity.id);
                let streams = [], avgPower = 0, maxPower = 0;
                if (streamSet && streamSet.length > 0) {
                    const sd = {};
                    streamSet.forEach(s => { sd[s.type] = s.data; });
                    const timeArr = sd.time || [];
                    for (let i = 0; i < timeArr.length; i++) {
                        streams.push({
                            time: timeArr[i],
                            power: sd.watts?.[i] ?? null,
                            heart_rate: sd.heartrate?.[i] ?? null,
                            cadence: sd.cadence?.[i] ?? null,
                            speed: sd.velocity_smooth?.[i] ?? null,
                            distance: sd.distance?.[i] ?? null
                        });
                    }
                    avgPower = sd.watts ? sd.watts.reduce((a, b) => a + b, 0) / sd.watts.length : 0;
                    maxPower = sd.watts ? Math.max(...sd.watts) : 0;
                }
                await db.addWorkout({
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
                    streams
                });
                newCount++;
            }
            await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
            if (!silent) setStravaSyncMsg(`Synced ${newCount} new Strava ride${newCount !== 1 ? 's' : ''}!`);
            if (newCount > 0) await loadData();
        } catch (err) {
            console.error('Dashboard Strava sync error:', err);
            if (!silent) setStravaSyncMsg(`Strava sync failed: ${err.message}`);
        } finally {
            if (!silent) {
                setStravaSyncing(false);
                setTimeout(() => setStravaSyncMsg(''), 5000);
            }
        }
    };

    const syncGarmin = async (silent = false) => {
        const connected = await db.getSettings('garmin_connected');
        if (!connected) return;
        if (!silent) setGarminSyncing(true);
        setGarminSyncMsg(silent ? '' : 'Syncing Garmin...');
        try {
            const activities = await fetchGarminActivities(200);
            if (!activities || activities.length === 0) {
                if (!silent) setGarminSyncMsg('No Garmin activities found.');
                return;
            }
            const existingWorkouts = await db.getWorkouts(currentUser.id);
            let newCount = 0;
            for (const activity of activities) {
                const isDup = existingWorkouts.some(w =>
                    w.garmin_id === activity.garmin_id ||
                    isSameStartTime(w.start_time, activity.start_time)
                );
                if (isDup) continue;
                await db.addWorkout({
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
                    avg_power: activity.avg_power || 0,
                    max_power: activity.max_power || 0,
                    avg_heart_rate: activity.avg_heart_rate || 0,
                    max_heart_rate: activity.max_heart_rate || 0,
                    normalized_power: activity.normalized_power || 0,
                    avg_cadence: activity.avg_cadence || 0,
                    calories: activity.calories || 0,
                    elevation_gain: activity.elevation_gain || 0,
                    training_stress_score: activity.training_stress_score || null,
                    intensity_factor: activity.intensity_factor || null,
                    power_curve: activity.power_curve || null,
                    streams: []
                });
                newCount++;
            }
            await db.saveSettings('garmin_last_sync', Math.floor(Date.now() / 1000));
            if (!silent) setGarminSyncMsg(`Synced ${newCount} new Garmin ride${newCount !== 1 ? 's' : ''}!`);
            if (newCount > 0) await loadData();
        } catch (err) {
            console.error('Dashboard Garmin sync error:', err);
            if (!silent) setGarminSyncMsg(`Garmin sync failed: ${err.message}`);
        } finally {
            if (!silent) {
                setGarminSyncing(false);
                setTimeout(() => setGarminSyncMsg(''), 5000);
            }
        }
    };

    useEffect(() => {
        loadData();

        // Check connection status and auto-sync if last sync was >1 hour ago
        const initSync = async () => {
            if (autoSyncRan.current) return;
            autoSyncRan.current = true;

            const stravaToken = await db.getSettings('strava_access_token');
            const garminConn = await db.getSettings('garmin_connected');
            setStravaConnected(!!stravaToken);
            setGarminConnected(!!garminConn);

            const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

            if (stravaToken) {
                const lastStravaSync = await db.getSettings('strava_last_sync');
                if (!lastStravaSync || lastStravaSync < oneHourAgo) {
                    await syncStrava(true);
                }
            }

            if (garminConn) {
                const lastGarminSync = await db.getSettings('garmin_last_sync');
                if (!lastGarminSync || lastGarminSync < oneHourAgo) {
                    await syncGarmin(true);
                }
            }
        };
        initSync();
    }, [currentUser]);

    if (!currentUser) return <div className="container">Loading user...</div>;

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Welcome back, {currentUser.name}</h1>
                <p className="text-muted">Here is your training summary (Last 7 Days).</p>
            </header>

            {/* Summary Widgets */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-lg)', marginBottom: 'var(--space-2xl)' }}>
                <div className="card">
                    <div className="flex-center" style={{ gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
                        <Activity size={20} color="var(--accent-primary)" />
                        <span className="text-muted">Weekly Rides</span>
                    </div>
                    <p className="text-2xl">{stats.count}</p>
                </div>
                <div className="card">
                    <div className="flex-center" style={{ gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
                        <Zap size={20} color="var(--accent-secondary)" />
                        <span className="text-muted">Weekly Distance</span>
                    </div>
                    <p className="text-2xl">{stats.distance} <span className="text-sm text-muted">km</span></p>
                </div>
                <div className="card">
                    <div className="flex-center" style={{ gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
                        <Clock size={20} color="var(--accent-tertiary)" />
                        <span className="text-muted">Weekly Duration</span>
                    </div>
                    <p className="text-2xl">{stats.duration} <span className="text-sm text-muted">hrs</span></p>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-xl)' }}>
                {/* Main Content Area */}
                <div>
                    <div className="card" style={{ marginBottom: 'var(--space-xl)' }}>
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Quick Upload</h3>
                        <FileDropzone onUploadComplete={loadData} />
                    </div>

                    <div>
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Recent Activity</h3>
                        {workouts.length === 0 ? (
                            <p className="text-muted">No rides uploaded yet.</p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                                {workouts.slice(0, 5).map(workout => (
                                    <div key={workout.id} className="card" style={{ padding: 'var(--space-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <div>
                                            <p className="text-sm text-muted" style={{ marginBottom: 4 }}>{new Date(workout.date).toLocaleDateString()}</p>
                                            <WorkoutPill
                                                workout={workout}
                                                onClick={() => setSelectedWorkout(workout)}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Sidebar / Performance Status */}
                <div>
                    {/* Sync Buttons */}
                    {(stravaConnected || garminConnected) && (
                        <div className="card" style={{ marginBottom: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                            <h3 className="text-sm text-muted" style={{ textTransform: 'uppercase', marginBottom: '2px' }}>Sync</h3>
                            {stravaConnected && (
                                <div>
                                    <button
                                        onClick={() => syncStrava(false)}
                                        disabled={stravaSyncing}
                                        style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                            width: '100%', padding: '7px 12px',
                                            background: '#fc4c02', color: 'white',
                                            border: 'none', borderRadius: 'var(--radius-sm)',
                                            cursor: stravaSyncing ? 'not-allowed' : 'pointer',
                                            fontSize: '0.82rem', fontWeight: 600,
                                            opacity: stravaSyncing ? 0.7 : 1
                                        }}
                                    >
                                        <RefreshCw size={13} style={stravaSyncing ? { animation: 'spin 1s linear infinite' } : {}} />
                                        {stravaSyncing ? 'Syncing Strava...' : 'Sync Strava'}
                                    </button>
                                    {stravaSyncMsg && <p className="text-xs" style={{ marginTop: '4px', color: stravaSyncMsg.includes('failed') ? 'var(--accent-danger)' : 'var(--text-secondary)' }}>{stravaSyncMsg}</p>}
                                </div>
                            )}
                            {garminConnected && (
                                <div>
                                    <button
                                        onClick={() => syncGarmin(false)}
                                        disabled={garminSyncing}
                                        style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                            width: '100%', padding: '7px 12px',
                                            background: '#007dc3', color: 'white',
                                            border: 'none', borderRadius: 'var(--radius-sm)',
                                            cursor: garminSyncing ? 'not-allowed' : 'pointer',
                                            fontSize: '0.82rem', fontWeight: 600,
                                            opacity: garminSyncing ? 0.7 : 1
                                        }}
                                    >
                                        <Watch size={13} style={garminSyncing ? { animation: 'spin 1s linear infinite' } : {}} />
                                        {garminSyncing ? 'Syncing Garmin...' : 'Sync Garmin'}
                                    </button>
                                    {garminSyncMsg && <p className="text-xs" style={{ marginTop: '4px', color: garminSyncMsg.includes('failed') ? 'var(--accent-danger)' : 'var(--text-secondary)' }}>{garminSyncMsg}</p>}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                        <div>
                            <h3 className="text-sm text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-xs)' }}>Current FTP</h3>
                            <p className="text-2xl" style={{ fontWeight: 'bold', color: 'var(--accent-primary)' }}>{currentUser.profile?.ftp || 250}W</p>

                            {performance.sessionDerivedFtp && (
                                <div style={{ marginTop: '4px' }}>
                                    <span className="text-xs text-muted">Interval Derived:</span>
                                    <span className="text-sm" style={{ marginLeft: 4, color: '#eab308', fontWeight: 600 }}>
                                        {performance.sessionDerivedFtp.low}W - {performance.sessionDerivedFtp.high}W
                                    </span>
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-sm)', borderTop: '1px solid var(--border-color)', paddingTop: 'var(--space-xs)' }}>
                                <div>
                                    <span className="text-xs text-muted">CP:</span>
                                    <span className="text-sm" style={{ marginLeft: 4 }}>{performance.cp?.cp ? `${performance.cp.cp}W` : '-'}</span>
                                </div>
                                <div>
                                    <span className="text-xs text-muted">AE:</span>
                                    <span className="text-sm" style={{ marginLeft: 4 }}>{performance.ae || '-'}</span>
                                </div>
                            </div>
                        </div>

                        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 'var(--space-md)' }}>
                            <h3 className="text-sm text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-xs)' }}>Athlete Strengths</h3>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                {performance.phenotype?.strengths?.map(s => (
                                    <span key={s} style={{ fontSize: '0.8rem', background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                                        {s}
                                    </span>
                                )) || <span className="text-xs text-muted">Calculating...</span>}
                            </div>
                            <p className="text-xs text-muted" style={{ marginTop: ' var(--space-xs)' }}>Type: {performance.phenotype?.type || 'All-Rounder'}</p>
                        </div>
                    </div>
                </div>
            </div>

            <Modal
                isOpen={!!selectedWorkout}
                onClose={() => setSelectedWorkout(null)}
                title={selectedWorkout?.title || 'Details'}
            >
                <RideDetailsModal workout={selectedWorkout} />
            </Modal>

        </div>
    );
};

export default Dashboard;
