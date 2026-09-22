import React, { useEffect, useState, useRef, useCallback } from 'react';
import { startOfWeek, endOfWeek, isWithinInterval, startOfDay, subDays, addDays } from 'date-fns';
import { useUser } from '../context/UserContext';
import { db, getLocalDayKey } from '../utils/db';
import { calculateCriticalPower, calculatePhenotype, calculateSessionDerivedFtp, buildCurveFromStreams, getWorkoutPowerCurve } from '../utils/analysis';
import { fetchStravaActivities, fetchStravaStreams } from '../utils/stravaApi';
import { fetchGarminActivities, fetchGarminActivityStreams, fetchGarminSleepData } from '../utils/garminApi';
import { beginSync, endSync, normalizeSyncMode, getStravaSyncWindow as buildStravaSyncWindow, getGarminSyncWindow as buildGarminSyncWindow, isDuplicateWorkout } from '../utils/syncService';
import FileDropzone from '../components/FileDropzone';
import WorkoutPill from '../components/WorkoutPill';
import Modal from '../components/Modal';
import RideDetailsModal from '../components/RideDetailsModal';
import { Activity, Clock, Zap, RefreshCw, Watch, Calendar } from 'lucide-react';

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
    const [stravaSyncMode, setStravaSyncMode] = useState('incremental');
    const [stravaSyncFrom, setStravaSyncFrom] = useState('');
    const [stravaSyncTo, setStravaSyncTo] = useState('');
    const [garminSyncing, setGarminSyncing] = useState(false);
    const [garminSyncMsg, setGarminSyncMsg] = useState('');
    const [garminSyncMode, setGarminSyncMode] = useState('incremental');
    const [garminSyncFrom, setGarminSyncFrom] = useState('');
    const [garminSyncTo, setGarminSyncTo] = useState('');
    const autoSyncRan = useRef(false);
    const hasBootstrappedRef = useRef(false);

    const bootstrapHistoricalDerivedMetrics = useCallback(async (existingWorkouts = []) => {
        if (!currentUser || hasBootstrappedRef.current) return existingWorkouts;

        const cacheKey = `historical_metrics_bootstrap_v1_${currentUser.id}_dashboard`;
        if (localStorage.getItem(cacheKey)) {
            hasBootstrappedRef.current = true;
            return existingWorkouts;
        }

        let updatedCount = 0;
        for (const workout of existingWorkouts) {
            const patch = {};
            const derivedPowerCurve = getWorkoutPowerCurve(workout);
            const normalizedPower = Number(workout.normalized_power || 0);
            const avgPower = Number(workout.avg_power || 0);

            if (derivedPowerCurve && JSON.stringify(derivedPowerCurve) !== JSON.stringify(workout.power_curve || null)) patch.power_curve = derivedPowerCurve;
            if (normalizedPower <= 0 && avgPower > 0) patch.normalized_power = avgPower;

            if (Object.keys(patch).length > 0 && workout.id != null) {
                await db.updateWorkout(workout.id, patch);
                updatedCount += 1;
            }
        }

        localStorage.setItem(cacheKey, JSON.stringify({
            updatedAt: new Date().toISOString(),
            updatedCount,
        }));
        hasBootstrappedRef.current = true;

        if (updatedCount > 0) {
            return db.getWorkouts(currentUser.id);
        }

        return existingWorkouts;
    }, [currentUser]);

    const getCompletionStatus = (workout, nowTs = Date.now()) => {
        if (!workout) return 'planned';
        if (workout.completion_status) return workout.completion_status;
        if (workout.completed === true) return 'completed';

        const actual = Number(workout.actual_tss);
        if (Number.isFinite(actual) && actual > 0) return 'completed';

        const ts = new Date(workout.date || workout.start_time).getTime();
        const isFuture = Number.isFinite(ts) && ts > nowTs;
        if (workout.planned === true || workout.plan_source === 'four_week' || isFuture) return 'planned';

        return 'completed';
    };

    const handleStravaSyncModeChange = async (mode) => {
        const normalizedMode = normalizeSyncMode(mode);
        setStravaSyncMode(normalizedMode);
        await db.saveSettings('sync_mode', normalizedMode);
        if (normalizedMode === 'incremental') {
            await db.saveSettings('sync_from', '');
            await db.saveSettings('sync_to', '');
            setStravaSyncFrom('');
            setStravaSyncTo('');
        } else if (normalizedMode === 'all') {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const fromStr = sixMonthsAgo.toISOString().split('T')[0];
            await db.saveSettings('sync_from', fromStr);
            await db.saveSettings('sync_to', '');
            setStravaSyncFrom(fromStr);
            setStravaSyncTo('');
        } else if (normalizedMode === 'fromDate') {
            await db.saveSettings('sync_to', '');
            setStravaSyncTo('');
        }
    };

    const handleStravaCustomDateChange = async (field, value) => {
        if (field === 'from') {
            setStravaSyncFrom(value);
            await db.saveSettings('sync_from', value);
        } else {
            setStravaSyncTo(value);
            await db.saveSettings('sync_to', value);
        }
    };

    const getStravaSyncWindow = async (silent = false) => {
        const lastSync = await db.getSettings('strava_last_sync');
        return buildStravaSyncWindow({
            mode: silent ? 'incremental' : stravaSyncMode,
            fromDate: stravaSyncFrom,
            toDate: stravaSyncTo,
            lastSyncEpoch: lastSync,
        });
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

    const getGarminSyncWindow = async (silent = false) => {
        const lastSync = await db.getSettings('garmin_last_sync');
        return buildGarminSyncWindow({
            mode: silent ? 'incremental' : garminSyncMode,
            fromDate: garminSyncFrom,
            toDate: garminSyncTo,
            lastSyncEpoch: lastSync,
        });
    };

    const loadData = async () => {
        if (!currentUser) return;
        let data = await db.getWorkouts(currentUser.id);
        data = await bootstrapHistoricalDerivedMetrics(data || []);
        const sorted = data.sort((a, b) => new Date(b.date) - new Date(a.date));
        setWorkouts(sorted);
        const completedSorted = sorted.filter(w => getCompletionStatus(w) === 'completed');
        const now = new Date();
        const nowTs = now.getTime();
        const pastWorkouts = sorted.filter((w) => {
            const d = new Date(w.date || w.start_time);
            if (!Number.isFinite(d.getTime()) || d.getTime() > nowTs) return false;
            return true;
        });

        // 1. Calculate Weekly Stats (Current week, Monday-Sunday, completed rides only)
        const weekStart = startOfWeek(now, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

        const weeklyWorkouts = sorted.filter(w => {
            const d = new Date(w.date || w.start_time);
            if (!isWithinInterval(d, { start: weekStart, end: weekEnd })) return false;
            return getCompletionStatus(w, nowTs) === 'completed';
        });

        const totalDist = weeklyWorkouts.reduce((acc, curr) => acc + (curr.total_distance || 0), 0);
        const totalTime = weeklyWorkouts.reduce((acc, curr) => acc + (curr.total_elapsed_time || 0), 0);

        setStats({
            count: weeklyWorkouts.length,
            distance: (totalDist / 1000).toFixed(1), // km
            duration: (totalTime / 3600).toFixed(1) // hours
        });

        const snapshotKey = `analysis_performance_snapshot_${currentUser.id}`;
        const analysisSnapshot = await db.getSettings(snapshotKey);

        if (analysisSnapshot && (analysisSnapshot.cp || analysisSnapshot.ae || analysisSnapshot.phenotype || analysisSnapshot.sessionDerivedFtp)) {
            setPerformance({
                cp: analysisSnapshot.cp || null,
                ae: analysisSnapshot.ae || null,
                phenotype: analysisSnapshot.phenotype || null,
                sessionDerivedFtp: analysisSnapshot.sessionDerivedFtp || null,
            });
        }

        // 2. Performance Metrics (copy Analysis page logic)
        const sixWeeksAgo = startOfDay(subDays(now, 42));
        const recentWorkouts = pastWorkouts.filter(w => new Date(w.date) >= sixWeeksAgo);

        const curveBests = {
            duration_5s: 0, duration_10s: 0,
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const allTimeEfPoints = [];

        pastWorkouts.forEach((workout) => {
            const wDate = new Date(workout.date);
            const workoutPowerCurve = getWorkoutPowerCurve(workout);

            const np = workout.normalized_power || workout.avg_power;
            const hr = workout.avg_heart_rate;
            const durationMin = Number(workout.total_elapsed_time || 0) / 60;
            const ftp = currentUser.profile?.ftp || 250;
            const ifVal = np ? (np / ftp) : null;

            if (ifVal && ifVal <= 0.80 && durationMin >= 30 && np && hr > 0) {
                allTimeEfPoints.push({
                    date: new Date(workout.date).getTime(),
                    ef: Number((np / hr).toFixed(2)),
                });
            }

            if (wDate >= sixWeeksAgo && workoutPowerCurve) {
                Object.keys(curveBests).forEach((key) => {
                    if ((workoutPowerCurve[key] || 0) > curveBests[key]) {
                        curveBests[key] = workoutPowerCurve[key];
                    }
                });
            }
        });

        allTimeEfPoints.sort((a, b) => a.date - b.date);

        try {
            const cp = calculateCriticalPower(curveBests);
            const phenotype = calculatePhenotype(curveBests, currentUser.profile?.weight || 70);
            const sessionDerivedFtp = calculateSessionDerivedFtp(recentWorkouts);
            const ae = allTimeEfPoints.length > 0
                ? Number(allTimeEfPoints[allTimeEfPoints.length - 1].ef).toFixed(2)
                : null;

            const mergedCp = cp || analysisSnapshot?.cp || null;
            const mergedAe = ae || analysisSnapshot?.ae || null;
            const mergedSessionDerivedFtp = sessionDerivedFtp || analysisSnapshot?.sessionDerivedFtp || null;
            const mergedPhenotype =
                (phenotype?.strengths?.length ? phenotype : null)
                || analysisSnapshot?.phenotype
                || phenotype
                || null;

            setPerformance({
                cp: mergedCp,
                ae: mergedAe,
                phenotype: mergedPhenotype,
                sessionDerivedFtp: mergedSessionDerivedFtp,
            });
        } catch (error) {
            console.warn('Dashboard performance metric fallback used due to compute error:', error?.message || error);
            if (analysisSnapshot && (analysisSnapshot.cp || analysisSnapshot.ae || analysisSnapshot.phenotype || analysisSnapshot.sessionDerivedFtp)) {
                setPerformance({
                    cp: analysisSnapshot.cp || null,
                    ae: analysisSnapshot.ae || null,
                    phenotype: analysisSnapshot.phenotype || null,
                    sessionDerivedFtp: analysisSnapshot.sessionDerivedFtp || null,
                });
            }
        }
    };

    const syncStrava = async (silent = false) => {
        const token = await db.getSettings('strava_access_token');
        if (!token) return;
        if (!beginSync('strava')) {
            if (!silent) setStravaSyncMsg('Strava sync is already running.');
            return;
        }
        if (!silent) setStravaSyncing(true);
        setStravaSyncMsg(silent ? '' : 'Syncing Strava...');
        try {
            const { afterEpoch, beforeEpoch } = await getStravaSyncWindow(silent);
            const activities = await fetchStravaActivities(afterEpoch, beforeEpoch);
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
                const isDup = existingWorkouts.some(w => isDuplicateWorkout(w, {
                    strava_id: activity.id,
                    start_time: activity.start_date,
                }));
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
                const incomingWorkout = {
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
                    power_curve: buildCurveFromStreams(streams, 'power'),
                    heart_rate_curve: buildCurveFromStreams(streams, 'heart_rate'),
                    streams
                };

                const upsertResult = await db.upsertWorkout(incomingWorkout);
                if (upsertResult.inserted) {
                    existingWorkouts.push(incomingWorkout);
                    newCount++;
                }
            }
            await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
            if (!silent) {
                setStravaSyncMsg(`Synced ${newCount} new Strava ride${newCount !== 1 ? 's' : ''}.`);
            }
            if (newCount > 0) {
                try {
                    await loadData();
                } catch (refreshErr) {
                    console.error('Dashboard Strava post-sync refresh error:', refreshErr);
                    if (!silent) {
                        setStravaSyncMsg(`Synced ${newCount} ride${newCount !== 1 ? 's' : ''}, but refresh failed.`);
                    }
                }
            }
        } catch (err) {
            console.error('Dashboard Strava sync error:', err);
            if (!silent) setStravaSyncMsg(`Strava sync failed: ${err.message}`);
        } finally {
            endSync('strava');
            if (!silent) {
                setStravaSyncing(false);
                setTimeout(() => setStravaSyncMsg(''), 5000);
            }
        }
    };

    const syncGarmin = async (silent = false) => {
        const connected = await db.getSettings('garmin_connected');
        if (!connected) return;
        if (!beginSync('garmin')) {
            if (!silent) setGarminSyncMsg('Garmin sync is already running.');
            return;
        }
        if (!silent) setGarminSyncing(true);
        setGarminSyncMsg(silent ? '' : 'Syncing Garmin...');
        try {
            const activities = await fetchGarminActivities(200);
            const { fromTs, toTs } = await getGarminSyncWindow(silent);
            const filteredActivities = (activities || []).filter(activity => {
                const startTs = new Date(activity.start_time).getTime();
                if (!Number.isFinite(startTs)) return false;
                if (fromTs && startTs < fromTs) return false;
                if (toTs && startTs > toTs) return false;
                return true;
            });

            if (!filteredActivities || filteredActivities.length === 0) {
                if (!silent) setGarminSyncMsg('No Garmin activities found.');
                return;
            }
            const existingWorkouts = await db.getWorkouts(currentUser.id);
            let newCount = 0;
            let backfilledCount = 0;
            for (const activity of filteredActivities) {
                const existingWorkout = existingWorkouts.find(w =>
                    w.garmin_id === activity.garmin_id ||
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

                const incomingWorkout = {
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
                };

                const upsertResult = await db.upsertWorkout(incomingWorkout);
                if (upsertResult.inserted) {
                    existingWorkouts.push(incomingWorkout);
                    newCount++;
                }
            }
            await db.saveSettings('garmin_last_sync', Math.floor(Date.now() / 1000));
            await syncGarminMetrics(true);
            if (!silent) {
                setGarminSyncMsg(`Synced ${newCount} new Garmin ride${newCount !== 1 ? 's' : ''}; backfilled ${backfilledCount} existing ride${backfilledCount !== 1 ? 's' : ''} with streams.`);
            }
            if (newCount > 0) {
                try {
                    await loadData();
                } catch (refreshErr) {
                    console.error('Dashboard Garmin post-sync refresh error:', refreshErr);
                    if (!silent) {
                        setGarminSyncMsg(`Synced ${newCount} ride${newCount !== 1 ? 's' : ''}, but refresh failed.`);
                    }
                }
            }
        } catch (err) {
            console.error('Dashboard Garmin sync error:', err);
            if (!silent) setGarminSyncMsg(`Garmin sync failed: ${err.message}`);
        } finally {
            endSync('garmin');
            if (!silent) {
                setGarminSyncing(false);
                setTimeout(() => setGarminSyncMsg(''), 5000);
            }
        }
    };

    // Backfills daily sleep/HRV metrics from Garmin for any missing days since the last sync,
    // without overwriting metrics the user has already entered or fetched.
    const syncGarminMetrics = async (silent = true) => {
        if (!currentUser) return;
        const connected = await db.getSettings('garmin_connected');
        if (!connected) return;
        if (!beginSync('garminMetrics')) return;

        try {
            const lastSync = await db.getSettings('garmin_metrics_last_sync');
            const fallbackDays = 14;
            const today = startOfDay(new Date());
            let cursor = lastSync ? startOfDay(new Date(lastSync * 1000)) : subDays(today, fallbackDays);

            while (cursor <= today) {
                const dateKey = getLocalDayKey(cursor);
                try {
                    const existing = await db.getMetric(currentUser.id, cursor);
                    if (!existing) {
                        const data = await fetchGarminSleepData(dateKey);
                        if (data?.found) {
                            await db.saveMetric(currentUser.id, cursor, {
                                sleepHours: data.sleepHours ?? 7,
                                sleepQuality: data.sleepQuality ?? 80,
                                hrv: data.avgHrv ?? 50,
                                feeling: 3,
                                source: 'garmin_auto'
                            });
                        }
                    }
                } catch (err) {
                    console.warn(`Garmin metrics sync failed for ${dateKey}:`, err.message);
                    if (/session expired|login again/i.test(err.message || '')) break;
                }
                cursor = addDays(cursor, 1);
            }

            await db.saveSettings('garmin_metrics_last_sync', Math.floor(Date.now() / 1000));
        } finally {
            endSync('garminMetrics');
            if (!silent) {
                try { await loadData(); } catch (e) { /* ignore refresh errors */ }
            }
        }
    };

    useEffect(() => {
        loadData();

        const onDataUpdated = (event) => {
            const eventUserId = event?.detail?.userId;
            if (eventUserId && Number(eventUserId) !== Number(currentUser?.id)) return;
            loadData();
        };
        window.addEventListener('training-data-updated', onDataUpdated);

        // Check connection status and auto-sync if last sync was >1 hour ago
        const initSync = async () => {
            if (autoSyncRan.current) return;
            autoSyncRan.current = true;

            const stravaToken = await db.getSettings('strava_access_token');
            const garminConn = await db.getSettings('garmin_connected');
            setStravaConnected(!!stravaToken);
            setGarminConnected(!!garminConn);

            const savedStravaSyncMode = await db.getSettings('sync_mode');
            if (savedStravaSyncMode) setStravaSyncMode(normalizeSyncMode(savedStravaSyncMode));
            const savedStravaSyncFrom = await db.getSettings('sync_from');
            if (savedStravaSyncFrom) setStravaSyncFrom(savedStravaSyncFrom);
            const savedStravaSyncTo = await db.getSettings('sync_to');
            if (savedStravaSyncTo) setStravaSyncTo(savedStravaSyncTo);

            const savedGarminSyncMode = await db.getSettings('garmin_sync_mode');
            if (savedGarminSyncMode) setGarminSyncMode(normalizeSyncMode(savedGarminSyncMode));
            const savedGarminSyncFrom = await db.getSettings('garmin_sync_from');
            if (savedGarminSyncFrom) setGarminSyncFrom(savedGarminSyncFrom);
            const savedGarminSyncTo = await db.getSettings('garmin_sync_to');
            if (savedGarminSyncTo) setGarminSyncTo(savedGarminSyncTo);

            const dedupeKey = `workout_dedupe_v1_done_${currentUser.id}`;
            const dedupeDone = await db.getSettings(dedupeKey);
            if (!dedupeDone) {
                const dedupeSummary = await db.cleanupDuplicateWorkouts(currentUser.id);
                await db.saveSettings(dedupeKey, {
                    ...dedupeSummary,
                    completedAt: new Date().toISOString(),
                });
            }

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
                await syncGarminMetrics(true);
            }
        };
        initSync();
        return () => window.removeEventListener('training-data-updated', onDataUpdated);
    }, [currentUser, bootstrapHistoricalDerivedMetrics]);

    if (!currentUser) return <div className="container">Loading user...</div>;

    const recentCompletedWorkouts = workouts
        .filter(workout => getCompletionStatus(workout) === 'completed')
        .slice(0, 5);

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Welcome back, {currentUser.name}</h1>
                <p className="text-muted">Here is your training summary (This Week: Mon-Sun, completed rides).</p>
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
                        {recentCompletedWorkouts.length === 0 ? (
                            <p className="text-muted">No completed rides yet.</p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                                {recentCompletedWorkouts.map(workout => (
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
                                    <div style={{ marginBottom: '8px', padding: '8px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                                            <Calendar size={13} color="var(--text-secondary)" />
                                            <span className="text-xs" style={{ fontWeight: 600 }}>Strava Sync Period</span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardStravaSyncMode" value="incremental" checked={stravaSyncMode === 'incremental'} onChange={() => handleStravaSyncModeChange('incremental')} />
                                                Incremental (since last sync)
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardStravaSyncMode" value="all" checked={stravaSyncMode === 'all'} onChange={() => handleStravaSyncModeChange('all')} />
                                                Backfill last 6 months
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardStravaSyncMode" value="custom" checked={stravaSyncMode === 'custom'} onChange={() => handleStravaSyncModeChange('custom')} />
                                                Custom date range
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardStravaSyncMode" value="fromDate" checked={stravaSyncMode === 'fromDate'} onChange={() => handleStravaSyncModeChange('fromDate')} />
                                                From date onward
                                            </label>

                                            {stravaSyncMode === 'custom' && (
                                                <div style={{ display: 'flex', gap: '6px', marginLeft: '20px', marginTop: '2px' }}>
                                                    <input
                                                        type="date"
                                                        value={stravaSyncFrom}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleStravaCustomDateChange('from', e.target.value)}
                                                        style={{ width: '100%', padding: '3px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                                    />
                                                    <input
                                                        type="date"
                                                        value={stravaSyncTo}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={stravaSyncFrom || (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleStravaCustomDateChange('to', e.target.value)}
                                                        style={{ width: '100%', padding: '3px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                                    />
                                                </div>
                                            )}

                                            {stravaSyncMode === 'fromDate' && (
                                                <div style={{ marginLeft: '20px', marginTop: '2px' }}>
                                                    <input
                                                        type="date"
                                                        value={stravaSyncFrom}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleStravaCustomDateChange('from', e.target.value)}
                                                        style={{ width: '100%', padding: '3px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
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
                                    <div style={{ marginBottom: '8px', padding: '8px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                                            <Calendar size={13} color="var(--text-secondary)" />
                                            <span className="text-xs" style={{ fontWeight: 600 }}>Garmin Sync Period</span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardGarminSyncMode" value="incremental" checked={garminSyncMode === 'incremental'} onChange={() => handleGarminSyncModeChange('incremental')} />
                                                Incremental (since last sync)
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardGarminSyncMode" value="all" checked={garminSyncMode === 'all'} onChange={() => handleGarminSyncModeChange('all')} />
                                                Backfill last 6 months
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardGarminSyncMode" value="custom" checked={garminSyncMode === 'custom'} onChange={() => handleGarminSyncModeChange('custom')} />
                                                Custom date range
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                                                <input type="radio" name="dashboardGarminSyncMode" value="fromDate" checked={garminSyncMode === 'fromDate'} onChange={() => handleGarminSyncModeChange('fromDate')} />
                                                From date onward
                                            </label>

                                            {garminSyncMode === 'custom' && (
                                                <div style={{ display: 'flex', gap: '6px', marginLeft: '20px', marginTop: '2px' }}>
                                                    <input
                                                        type="date"
                                                        value={garminSyncFrom}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleGarminCustomDateChange('from', e.target.value)}
                                                        style={{ width: '100%', padding: '3px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                                    />
                                                    <input
                                                        type="date"
                                                        value={garminSyncTo}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={garminSyncFrom || (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleGarminCustomDateChange('to', e.target.value)}
                                                        style={{ width: '100%', padding: '3px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                                    />
                                                </div>
                                            )}

                                            {garminSyncMode === 'fromDate' && (
                                                <div style={{ marginLeft: '20px', marginTop: '2px' }}>
                                                    <input
                                                        type="date"
                                                        value={garminSyncFrom}
                                                        max={new Date().toISOString().split('T')[0]}
                                                        min={(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })()}
                                                        onChange={(e) => handleGarminCustomDateChange('from', e.target.value)}
                                                        style={{ width: '100%', padding: '3px 6px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
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
                                {(performance.phenotype?.strengths?.length ? performance.phenotype.strengths : []).map(s => (
                                    <span key={s} style={{ fontSize: '0.8rem', background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                                        {s}
                                    </span>
                                ))}
                                {(!performance.phenotype?.strengths || performance.phenotype.strengths.length === 0) && (
                                    <span className="text-xs text-muted">Need more sustained power data (3m+ and 20m efforts).</span>
                                )}
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
                <RideDetailsModal workout={selectedWorkout} onClose={() => setSelectedWorkout(null)} />
            </Modal>

        </div>
    );
};

export default Dashboard;
