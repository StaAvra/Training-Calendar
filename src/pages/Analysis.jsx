import React, { useEffect, useState, useRef, useCallback } from 'react';
import { subWeeks, startOfDay, startOfWeek, endOfWeek, format } from 'date-fns';
import { useUser } from '../context/UserContext';
import { db, getLocalDayKey } from '../utils/db';
import { calculateTimeInZones, calculateZones, calculateEstimatedFtp, calculateCriticalPower, calculateCriticalHeartRate, calculatePhenotype, calculateSessionDerivedFtp, checkFtpImprovement, calculateTssWithMetadata, calculateTimeInHRZones, calculateHRZones, calculateInterpolatedScore, calculateTrainingDNA, getWorkoutPowerCurve, getWorkoutHeartRateCurve } from '../utils/analysis';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LineChart, Line, ReferenceLine, Area, Legend, ComposedChart, AreaChart } from 'recharts';
import { Activity, TrendingUp, Calculator, Zap, Heart } from 'lucide-react';
import Modal from '../components/Modal'; // Reuse Modal
import styles from './Analysis.module.css';

const HISTORICAL_METRICS_BOOTSTRAP_VERSION = 1;

const Analysis = () => {
    const { currentUser } = useUser();
    const [workouts, setWorkouts] = useState([]);
    const [zoneData, setZoneData] = useState([]);
    const [hrZoneData, setHrZoneData] = useState([]);
    const [dnaData, setDnaData] = useState(null);
    const [loading, setLoading] = useState(true);

    // Power Curve & CP State
    const [powerCurve, setPowerCurve] = useState([]);
    const [allTimePowerCurve, setAllTimePowerCurve] = useState([]);
    const [criticalPower, setCriticalPower] = useState(null);
    const [criticalHeartRate, setCriticalHeartRate] = useState(null);
    const [sessionDerivedFtp, setSessionDerivedFtp] = useState(null);
    const [efData, setEfData] = useState([]);
    const [multiTrendData, setMultiTrendData] = useState([]);
    const [baselineTrendData, setBaselineTrendData] = useState([]);
    const [weeklyTssData, setWeeklyTssData] = useState([]);

    // FTP Modal State
    const [isFtpModalOpen, setIsFtpModalOpen] = useState(false);
    const [estimatedFtp, setEstimatedFtp] = useState(null);
    const [ftpMessage, setFtpMessage] = useState('');
    const [ftpSuggestion, setFtpSuggestion] = useState(null);
    const hasBootstrappedRef = useRef(false);

    const bootstrapHistoricalDerivedMetrics = useCallback(async (existingWorkouts = []) => {
        if (!currentUser || hasBootstrappedRef.current) return existingWorkouts;

        const cacheKey = `historical_metrics_bootstrap_v${HISTORICAL_METRICS_BOOTSTRAP_VERSION}_${currentUser.id}`;
        if (localStorage.getItem(cacheKey)) {
            hasBootstrappedRef.current = true;
            return existingWorkouts;
        }

        let updatedCount = 0;
        for (const workout of existingWorkouts) {
            const patch = {};
            const derivedPowerCurve = getWorkoutPowerCurve(workout);
            const derivedHrCurve = getWorkoutHeartRateCurve(workout);
            const normalizedPower = Number(workout.normalized_power || 0);
            const avgPower = Number(workout.avg_power || 0);

            if (derivedPowerCurve && JSON.stringify(derivedPowerCurve) !== JSON.stringify(workout.power_curve || null)) patch.power_curve = derivedPowerCurve;
            if (derivedHrCurve && JSON.stringify(derivedHrCurve) !== JSON.stringify(workout.heart_rate_curve || null)) patch.heart_rate_curve = derivedHrCurve;
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

    const refreshAnalysisData = useCallback(async () => {
        if (!currentUser) return;
        let storedWorkouts = await db.getWorkouts(currentUser.id);
        storedWorkouts = storedWorkouts || [];
        storedWorkouts = await bootstrapHistoricalDerivedMetrics(storedWorkouts);
        setWorkouts(storedWorkouts || []);
        setLoading(false);
    }, [currentUser, bootstrapHistoricalDerivedMetrics]);

    useEffect(() => {
        refreshAnalysisData();
    }, [refreshAnalysisData]);

    useEffect(() => {
        if (!currentUser) return undefined;

        const onDataUpdated = (event) => {
            const eventUserId = event?.detail?.userId;
            if (eventUserId && Number(eventUserId) !== Number(currentUser.id)) return;
            refreshAnalysisData();
        };

        window.addEventListener('training-data-updated', onDataUpdated);
        return () => window.removeEventListener('training-data-updated', onDataUpdated);
    }, [currentUser, refreshAnalysisData]);

    // Phenotype state
    const [phenotype, setPhenotype] = useState({ type: 'All-Rounder', adj: 0 });

    // HR-based TSS estimates
    const [hrBasedTssEstimates, setHrBasedTssEstimates] = useState([]);

    useEffect(() => {
        if (!workouts.length || !currentUser) return;

        // 1. Cutoff Dates
        const now = new Date();
        const nowTs = now.getTime();
        const pastWorkouts = workouts.filter(w => {
            const rideTs = new Date(w.date).getTime();
            return Number.isFinite(rideTs) && rideTs <= nowTs;
        });
        const cutoff6Weeks = startOfDay(subWeeks(now, 6));
        const cutoff4Weeks = startOfDay(subWeeks(now, 4));

        // 2. Filter Workouts for Rolling Metrics
        const recentWorkouts = pastWorkouts.filter(w => new Date(w.date) >= cutoff6Weeks);

        // 3. Aggregate Time in Zones (Last 4 Weeks)
        const zones = calculateZones(currentUser.profile.ftp);
        const aggregatedZones = zones.map(z => ({ name: z.name, time: 0, color: z.color }));

        // HR Zones (Last 4 Weeks)
        const maxHr = currentUser.profile.maxHr || 190; // Default to 190 if not provided
        const hrZones = calculateHRZones(maxHr);
        const aggregatedHrZones = hrZones.map(z => ({ name: z.name, time: 0, color: z.color }));

        // 4. Aggregate Power Curve (Last 6 Weeks vs All Time)
        const curveBests = {
            duration_5s: 0, duration_10s: 0,
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const allTimeCurveBests = {
            duration_5s: 0, duration_10s: 0,
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const hrBests = {
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const allTimeEfPoints = [];

        // Scan ALL workouts
        pastWorkouts.forEach(workout => {
            const wDate = new Date(workout.date);
            const workoutPowerCurve = getWorkoutPowerCurve(workout);
            const workoutHeartRateCurve = getWorkoutHeartRateCurve(workout);

            // Time in Zones (4 Weeks)
            if (wDate >= cutoff4Weeks && workout.streams) {
                const distribution = calculateTimeInZones(workout.streams, currentUser.profile.ftp);
                distribution.forEach((d, i) => {
                    aggregatedZones[i].time += (d.time / 60);
                });

                // Time in HR Zones (4 Weeks)
                const hrDistribution = calculateTimeInHRZones(workout.streams, maxHr);
                hrDistribution.forEach((d, i) => {
                    aggregatedHrZones[i].time += (d.time / 60);
                });
            }

            // All-Time Power Curve
            if (workoutPowerCurve) {
                Object.keys(allTimeCurveBests).forEach(key => {
                    if ((workoutPowerCurve[key] || 0) > allTimeCurveBests[key]) {
                        allTimeCurveBests[key] = workoutPowerCurve[key];
                    }
                });
            }

            // All-Time EF
            const np = workout.normalized_power || workout.avg_power;
            const hr = workout.avg_heart_rate;
            const durationMin = workout.total_elapsed_time / 60;
            // Always recalculate IF against current FTP for consistent filtering
            const ftp = currentUser.profile?.ftp || 250;
            const ifVal = np ? (np / ftp) : null;

            if (ifVal && ifVal <= 0.80 && durationMin >= 30 && np && hr > 0) {
                allTimeEfPoints.push({
                    date: new Date(workout.date).getTime(),
                    ef: Number((np / hr).toFixed(2)),
                    name: workout.name || workout.title || 'Ride',
                    np: Math.round(np),
                    hr: Math.round(hr),
                });
            }

            // Last 6 Weeks Specifics
            if (wDate >= cutoff6Weeks) {
                if (workoutPowerCurve) {
                    Object.keys(curveBests).forEach(key => {
                        if ((workoutPowerCurve[key] || 0) > curveBests[key]) {
                            curveBests[key] = workoutPowerCurve[key];
                        }
                    });
                }
                if (workoutHeartRateCurve) {
                    Object.keys(hrBests).forEach(key => {
                        if ((workoutHeartRateCurve[key] || 0) > hrBests[key]) {
                            hrBests[key] = workoutHeartRateCurve[key];
                        }
                    });
                }
            }
        });

        const finalZoneData = aggregatedZones.map(z => ({ ...z, time: Number(z.time.toFixed(1)) }));
        setZoneData(finalZoneData);

        const finalHrZoneData = aggregatedHrZones.map(z => ({ ...z, time: Number(z.time.toFixed(1)) }));
        setHrZoneData(finalHrZoneData);

        // Training DNA (stacked area chart)
        db.getMetrics(currentUser.id).then(metricsData => {
            const dna = calculateTrainingDNA(pastWorkouts, metricsData || [], currentUser.profile?.ftp);
            setDnaData(dna);
        });

        // Calculate HR-based TSS estimates for workouts without power data
        const hrBasedEstimates = [];
        pastWorkouts.forEach(workout => {
            // Only estimate for rides without power but with HR
            const np = workout.normalized_power || workout.avg_power;
            if (!np && workout.avg_heart_rate && workout.total_elapsed_time) {
                const result = calculateTssWithMetadata(workout, currentUser.profile?.ftp);
                if (result.tss) {
                    hrBasedEstimates.push({
                        id: workout.id,
                        date: new Date(workout.date).toLocaleDateString(),
                        tss: result.tss,
                        method: result.method,
                        confidence: (result.confidence * 100).toFixed(0),
                        ifEstimate: result.ifEstimate?.toFixed(2)
                    });
                }
            }
        });
        setHrBasedTssEstimates(hrBasedEstimates);

        // Weekly TSS trend: Actual (last 12 weeks) + Projected (future planned weeks)
        const getCompletionStatus = (workout) => {
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

        const getActualTss = (workout) => {
            const status = getCompletionStatus(workout);
            if (status !== 'completed') return 0;

            const actual = Number(workout.actual_tss);
            if (Number.isFinite(actual) && actual > 0) return actual;

            const recalculated = Number(calculateTssWithMetadata(workout, currentUser.profile?.ftp)?.tss);
            if (Number.isFinite(recalculated) && recalculated > 0) return recalculated;

            const stored = Number(workout.training_stress_score);
            if (Number.isFinite(stored) && stored > 0) return stored;

            return 0;
        };

        const getProjectedTss = (workout) => {
            const expected = Number(workout.expected_tss);
            if (Number.isFinite(expected) && expected > 0) return expected;

            const recalculated = Number(calculateTssWithMetadata(workout, currentUser.profile?.ftp)?.tss);
            if (Number.isFinite(recalculated) && recalculated > 0) return recalculated;

            const stored = Number(workout.training_stress_score);
            if (Number.isFinite(stored) && stored > 0) return stored;

            return 0;
        };

        const weekRows = new Map();
        for (let i = 11; i >= 0; i--) {
            const weekStart = startOfWeek(subWeeks(now, i), { weekStartsOn: 1 });
            const key = getLocalDayKey(weekStart);
            weekRows.set(key, {
                week: format(weekStart, 'MMM d'),
                actualTss: 0,
                projectedTss: null,
                _sortTs: weekStart.getTime(),
            });
        }

        pastWorkouts.forEach((w) => {
            const d = startOfDay(new Date(w.date));
            if (!Number.isFinite(d.getTime())) return;
            const weekStart = startOfWeek(d, { weekStartsOn: 1 });
            const key = getLocalDayKey(weekStart);
            const existing = weekRows.get(key);
            if (!existing) return;
            existing.actualTss = Math.round((existing.actualTss || 0) + getActualTss(w));
        });

        const plannedFuture = workouts.filter(w => {
            const ts = new Date(w.date).getTime();
            const status = getCompletionStatus(w);
            const isPlanned = w.planned === true || w.plan_source === 'four_week' || status === 'planned';
            return Number.isFinite(ts) && ts > nowTs && isPlanned && status !== 'completed';
        });

        const futureWeekMap = new Map();
        plannedFuture.forEach(w => {
            const weekStart = startOfWeek(startOfDay(new Date(w.date)), { weekStartsOn: 1 });
            const key = getLocalDayKey(weekStart);
            const prev = futureWeekMap.get(key) || 0;
            futureWeekMap.set(key, prev + getProjectedTss(w));
        });

        Array.from(futureWeekMap.entries())
            .map(([weekKey, total]) => {
                const weekStart = new Date(`${weekKey}T00:00:00`);
                return {
                    key: weekKey,
                    week: format(weekStart, 'MMM d'),
                    projectedTss: Math.round(total),
                    _sortTs: weekStart.getTime(),
                };
            })
            .sort((a, b) => a._sortTs - b._sortTs)
            .slice(0, 12)
            .forEach(({ key, week, projectedTss, _sortTs }) => {
                const existing = weekRows.get(key);
                if (existing) {
                    existing.projectedTss = projectedTss;
                    return;
                }
                weekRows.set(key, {
                    week,
                    actualTss: null,
                    projectedTss,
                    _sortTs,
                });
            });

        const finalWeeklyTssData = Array.from(weekRows.values())
            .sort((a, b) => a._sortTs - b._sortTs)
            .map(({ _sortTs, ...rest }) => rest);

        setWeeklyTssData(finalWeeklyTssData);

        // Build a single sorted EF dataset from all qualifying rides
        allTimeEfPoints.sort((a, b) => a.date - b.date);
        allTimeEfPoints.forEach(p => {
            p.label = new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });
        setEfData(allTimeEfPoints);

        const labels = {
            duration_5s: '5s', duration_10s: '10s',
            duration_1m: '1m', duration_2m: '2m', duration_3m: '3m', duration_5m: '5m',
            duration_8m: '8m', duration_10m: '10m', duration_20m: '20m', duration_60m: '60m'
        };

        const order = ['duration_5s', 'duration_10s', 'duration_1m', 'duration_2m', 'duration_3m', 'duration_5m', 'duration_8m', 'duration_10m', 'duration_20m', 'duration_60m'];

        const curveChartData = Object.keys(curveBests).map(key => ({
            name: labels[key],
            time: key,
            power: curveBests[key],
            allTimePower: allTimeCurveBests[key]
        })).filter(d => d.power > 0 || d.allTimePower > 0);

        curveChartData.sort((a, b) => order.indexOf(a.time) - order.indexOf(b.time));
        setPowerCurve(curveChartData);

        // Detect Phenotype
        const detectedPhenotype = calculatePhenotype(curveBests, currentUser.profile.weight || 70);
        setPhenotype(detectedPhenotype);

        // CP & CHR (6-Week bests)
        const cpSnapshot = calculateCriticalPower(curveBests);
        setCriticalPower(cpSnapshot);
        setCriticalHeartRate(calculateCriticalHeartRate(hrBests));

        // Session Derived FTP
        const sessionDerivedFtpSnapshot = calculateSessionDerivedFtp(recentWorkouts);
        setSessionDerivedFtp(sessionDerivedFtpSnapshot);

        const latestEfSnapshot = allTimeEfPoints.length > 0
            ? Number(allTimeEfPoints[allTimeEfPoints.length - 1].ef).toFixed(2)
            : null;

        const performanceSnapshot = {
            userId: currentUser.id,
            updatedAt: new Date().toISOString(),
            cp: cpSnapshot,
            ae: latestEfSnapshot,
            phenotype: detectedPhenotype,
            sessionDerivedFtp: sessionDerivedFtpSnapshot,
        };
        void db.saveSettings(`analysis_performance_snapshot_${currentUser.id}`, performanceSnapshot)
            .then(() => {
                window.dispatchEvent(new CustomEvent('training-data-updated', {
                    detail: { entity: 'analysis_snapshot', action: 'update', userId: currentUser.id }
                }));
            })
            .catch((err) => {
                console.warn('Failed to persist analysis performance snapshot:', err?.message || err);
            });

        // FTP improvement suggestion (use profile for CHR fallback)
        try {
            const suggestion = checkFtpImprovement(pastWorkouts, currentUser.profile?.ftp, currentUser.profile);
            setFtpSuggestion(suggestion);
        } catch (e) {
            setFtpSuggestion(null);
        }

        // === Recovery + Rolling-Max Trend Data ===
        (async () => {
            try {
                const metrics = await db.getMetrics(currentUser.id);
                const buildWeeks = (count) => {
                    const built = [];
                    for (let i = count - 1; i >= 0; i--) {
                        const weekStart = startOfWeek(subWeeks(now, i), { weekStartsOn: 1 });
                        const weekEnd = endOfWeek(subWeeks(now, i), { weekStartsOn: 1 });
                        built.push({ start: weekStart, end: weekEnd, label: format(weekStart, 'MMM d') });
                    }
                    return built;
                };

                const buildWeeklyRawPoint = (week) => {
                    const weekMetrics = metrics.filter(m => {
                        const d = new Date(m.date);
                        return d >= week.start && d <= week.end;
                    });
                    const hrvValues = weekMetrics.map(m => Number(m.hrv)).filter(v => Number.isFinite(v) && v > 0);
                    const sleepValues = weekMetrics.map(m => Number(m.sleepQuality)).filter(v => Number.isFinite(v) && v > 0);

                    const weekWorkouts = pastWorkouts.filter(w => {
                        const d = new Date(w.date);
                        return d >= week.start && d <= week.end;
                    });

                    const weekBests = { duration_1m: 0, duration_3m: 0, duration_5m: 0, duration_20m: 0 };
                    weekWorkouts.forEach(w => {
                        const workoutPowerCurve = getWorkoutPowerCurve(w);
                        if (!workoutPowerCurve) return;
                        Object.keys(weekBests).forEach((k) => {
                            if ((workoutPowerCurve[k] || 0) > weekBests[k]) weekBests[k] = workoutPowerCurve[k];
                        });
                    });

                    const weekCp = calculateCriticalPower(weekBests);
                    const intervalFtp = calculateSessionDerivedFtp(weekWorkouts);
                    const intervalFtpMid = intervalFtp ? Math.round((Number(intervalFtp.low || 0) + Number(intervalFtp.high || 0)) / 2) : null;
                    const weekTss = Math.round(weekWorkouts.reduce((sum, workout) => sum + getActualTss(workout), 0));

                    return {
                        week: week.label,
                        rawHrv: hrvValues.length ? Math.round(hrvValues.reduce((s, v) => s + v, 0) / hrvValues.length) : null,
                        rawSleep: sleepValues.length ? Math.round(sleepValues.reduce((s, v) => s + v, 0) / sleepValues.length) : null,
                        rawTss: weekTss > 0 ? weekTss : null,
                        rawCp: weekCp ? weekCp.cp : null,
                        raw1m: weekBests.duration_1m || null,
                        raw5m: weekBests.duration_5m || null,
                        raw20m: weekBests.duration_20m || null,
                        rawIntervalFtp: intervalFtpMid && intervalFtpMid > 0 ? intervalFtpMid : null,
                    };
                };

                const buildRanges = (points, keys) => {
                    const ranges = {};
                    keys.forEach((key) => {
                        const values = points.map(p => p[key]).filter(v => v != null);
                        if (!values.length) return;
                        const min = Math.min(...values);
                        const max = Math.max(...values);
                        ranges[key] = { min, max, span: max - min || 1 };
                    });
                    return ranges;
                };

                const normalize = (value, key, ranges) => {
                    if (value == null || !ranges[key]) return null;
                    return Math.round(((value - ranges[key].min) / ranges[key].span) * 80 + 10);
                };

                // Chart 1: Recovery view (last 6 weeks): HRV, Sleep, and Weekly TSS.
                const recoveryRaw = buildWeeks(6).map(buildWeeklyRawPoint);
                const recoveryKeys = ['rawHrv', 'rawSleep', 'rawTss'];
                const recoveryRanges = buildRanges(recoveryRaw, recoveryKeys);
                const recoveryNormalized = recoveryRaw.map((point) => ({
                    week: point.week,
                    hrv: normalize(point.rawHrv, 'rawHrv', recoveryRanges),
                    sleep: normalize(point.rawSleep, 'rawSleep', recoveryRanges),
                    tss: normalize(point.rawTss, 'rawTss', recoveryRanges),
                    _rawHrv: point.rawHrv,
                    _rawSleep: point.rawSleep,
                    _rawTss: point.rawTss,
                }));
                setMultiTrendData(recoveryNormalized);

                // Chart 2: Last 3 months, normalized rolling 4-week maxima.
                const rollingRaw = buildWeeks(12).map(buildWeeklyRawPoint);
                const rollingKeys = ['rawHrv', 'rawSleep', 'rawCp', 'raw1m', 'raw5m', 'raw20m', 'rawIntervalFtp'];
                const rollingMaxRaw = rollingRaw.map((point, index) => {
                    if (index < 3) {
                        return {
                            week: point.week,
                            rawHrv: null,
                            rawSleep: null,
                            rawCp: null,
                            raw1m: null,
                            raw5m: null,
                            raw20m: null,
                            rawIntervalFtp: null,
                        };
                    }
                    const window = rollingRaw.slice(index - 3, index + 1);
                    const maxOfKey = (key) => {
                        const vals = window.map(w => w[key]).filter(v => v != null);
                        return vals.length ? Math.max(...vals) : null;
                    };
                    return {
                        week: point.week,
                        rawHrv: maxOfKey('rawHrv'),
                        rawSleep: maxOfKey('rawSleep'),
                        rawCp: maxOfKey('rawCp'),
                        raw1m: maxOfKey('raw1m'),
                        raw5m: maxOfKey('raw5m'),
                        raw20m: maxOfKey('raw20m'),
                        rawIntervalFtp: maxOfKey('rawIntervalFtp'),
                    };
                });

                const rollingRanges = buildRanges(rollingMaxRaw, rollingKeys);
                const rollingNormalized = rollingMaxRaw.map((point) => ({
                    week: point.week,
                    hrv: normalize(point.rawHrv, 'rawHrv', rollingRanges),
                    sleep: normalize(point.rawSleep, 'rawSleep', rollingRanges),
                    cp: normalize(point.rawCp, 'rawCp', rollingRanges),
                    p1m: normalize(point.raw1m, 'raw1m', rollingRanges),
                    p5m: normalize(point.raw5m, 'raw5m', rollingRanges),
                    p20m: normalize(point.raw20m, 'raw20m', rollingRanges),
                    intervalFtp: normalize(point.rawIntervalFtp, 'rawIntervalFtp', rollingRanges),
                    _rawHrv: point.rawHrv,
                    _rawSleep: point.rawSleep,
                    _rawCp: point.rawCp,
                    _raw1m: point.raw1m,
                    _raw5m: point.raw5m,
                    _raw20m: point.raw20m,
                    _rawIntervalFtp: point.rawIntervalFtp,
                }));
                setBaselineTrendData(rollingNormalized);
            } catch (e) {
                console.error('Multi-trend aggregation error:', e);
            }
        })();

    }, [workouts, currentUser]);

    // Prepare performance profile mapping (internal categories)
    const categoryOrder = ['Untrained', 'Fair', 'Moderate', 'Good', 'Very good', 'Excellent', 'Exceptional'];
    const categoryToScore = Object.fromEntries(categoryOrder.map((c, i) => [c, i]));
    // Shift displayed labels one up: Untrained->Fair, Fair->Moderate, ..., Exceptional->Exceptional
    const displayLabels = categoryOrder.slice(1).concat(categoryOrder[categoryOrder.length - 1]);
    const shiftMap = Object.fromEntries(categoryOrder.map((c, i) => [c, displayLabels[i]]));

    // Original color palette per internal category (Untrained..Exceptional)
    const baseColors = ['#ef4444', '#f97316', '#f59e0b', '#fbbf24', '#34d399', '#60a5fa', '#7c3aed'];
    // Map display labels to colors shifted up so the displayed 'Fair' uses previous 'Untrained' color
    const displayColor = Object.fromEntries(displayLabels.map((lab, i) => [lab, baseColors[i]]));

    // Color mapping for categories (from low -> high)
    const categoryColor = {
        'Untrained': '#ef4444', // red
        'Fair': '#f97316', // orange
        'Moderate': '#f59e0b', // amber
        'Good': '#fbbf24', // yellow
        'Very good': '#34d399', // green
        'Excellent': '#60a5fa', // light blue
        'Exceptional': '#7c3aed' // purple
    };

    // Calculate normalized profile data using linear interpolation for fine-grained scoring
    const profileData = (() => {
        if (!phenotype || !phenotype.scores || !phenotype.performanceBreakdown) return [];

        const sex = currentUser?.profile?.sex || 'male';

        // Step 1: Get raw W/kg values and calculate interpolated scores
        const rawScores = [
            {
                name: '5s',
                key: 'sprint',
                raw: phenotype.scores.sprint,
                category: phenotype.performanceBreakdown.categories.sprint,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.sprint, 'sprint', sex)
            },
            {
                name: '1m',
                key: 'anaerobic',
                raw: phenotype.scores.anaerobic,
                category: phenotype.performanceBreakdown.categories.anaerobic,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.anaerobic, 'anaerobic', sex)
            },
            {
                name: '5m',
                key: 'vo2max',
                raw: phenotype.scores.vo2max,
                category: phenotype.performanceBreakdown.categories.vo2max,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.vo2max, 'vo2max', sex)
            },
            {
                name: '20m',
                key: 'threshold',
                raw: phenotype.scores.threshold,
                category: phenotype.performanceBreakdown.categories.threshold,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.threshold, 'threshold', sex)
            }
        ];

        // Debug logging
        console.log('Performance Profile Debug:', {
            phenotypeScores: phenotype.scores,
            rawScores: rawScores.map(s => ({
                name: s.name,
                raw: s.raw,
                interpolatedScore: s.interpolatedScore
            })),
            sex
        });

        // Step 2: Find the highest interpolated score (user's strongest discipline)
        const maxInterpolatedScore = Math.max(...rawScores.map(s => s.interpolatedScore));

        if (maxInterpolatedScore === 0) return [];

        // Step 3: Normalize interpolated scores to 100 (where 100 = strongest discipline)
        return rawScores.map(score => {
            const normalized = (score.interpolatedScore / maxInterpolatedScore) * 100;
            // Color gradient based on normalized score
            const getColor = (norm) => {
                if (norm >= 95) return '#22c55e'; // Green for strongest
                if (norm >= 85) return '#84cc16'; // Light green
                if (norm >= 75) return '#eab308'; // Yellow
                if (norm >= 65) return '#f97316'; // Orange
                return '#ef4444'; // Red for weakest
            };

            return {
                ...score,
                value: normalized,
                color: getColor(normalized)
            };
        });
    })();

    const ProfileTooltip = ({ active, payload, label }) => {
        if (!active || !payload || !payload.length) return null;
        const p = payload[0].payload;
        return (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '8px', color: 'var(--text-primary)' }}>
                <div style={{ fontWeight: 700 }}>{label}</div>
                <div style={{ marginTop: 6 }}>Normalized Score: {p.value ? p.value.toFixed(1) : '—'}</div>
                <div>W/kg: {p.raw ? Number(p.raw).toFixed(2) : '—'}</div>
                <div style={{ fontSize: '0.85em', color: 'var(--text-secondary)', marginTop: 4 }}>Category: {p.category ? (shiftMap[p.category] || p.category) : '—'}</div>
            </div>
        );
    };

    const handleEstimateFtp = () => {
        setLoading(true);
        setTimeout(() => {
            const now = new Date();
            const cutoff6Weeks = subWeeks(new Date(), 6);
            const recentWorkouts = workouts.filter(w => {
                const rideDate = new Date(w.date);
                const rideTs = rideDate.getTime();
                return Number.isFinite(rideTs) && rideDate >= cutoff6Weeks && rideDate <= now;
            });

            const estimate = calculateEstimatedFtp(recentWorkouts, phenotype);
            const current = currentUser.profile.ftp;

            if (estimate) {
                setEstimatedFtp(estimate.avg);
                const rangeStr = `${estimate.low}W - ${estimate.high}W`;
                if (estimate.avg > current) {
                    setFtpMessage(`Based on your Last 6 Weeks and ${phenotype.type} phenotype, your FTP is estimated at ${estimate.avg}W (${rangeStr}). Current: ${current}W.`);
                } else {
                    setFtpMessage(`Based on your Last 6 Weeks, your FTP is estimated at ${estimate.avg}W (${rangeStr}).`);
                }
            } else {
                setEstimatedFtp(null);
                setFtpMessage("Not enough 8-20min efforts in the last 6 weeks to estimate FTP.");
            }
            setIsFtpModalOpen(true);
            setLoading(false);
        }, 100);
    };

    const confirmFtpUpdate = async () => {
        if (!estimatedFtp) return;
        const updatedProfile = { ...currentUser.profile, ftp: estimatedFtp };
        await db.updateUser(currentUser.id, { profile: updatedProfile });
        setEstimatedFtp(null);
        setFtpMessage('FTP updated — saved to your profile.');
        setIsFtpModalOpen(false);
    };

    const applyFtpSuggestion = async () => {
        if (!ftpSuggestion || !ftpSuggestion.suggestedUpdate) return;
        const updatedProfile = { ...currentUser.profile, ftp: ftpSuggestion.suggestedUpdate };
        await db.updateUser(currentUser.id, { profile: updatedProfile });
        setFtpSuggestion(null);
        setFtpMessage(`Applied suggested FTP: ${updatedProfile.ftp} W`);
    };

    const pastWorkoutsForDisplay = workouts.filter(w => {
        const rideTs = new Date(w.date).getTime();
        return Number.isFinite(rideTs) && rideTs <= Date.now();
    });

    const hrToleranceDeltas = [5, 10, 15];
    const hrToleranceRows = criticalHeartRate
        ? hrToleranceDeltas.map(delta => {
            const rawMinutes = criticalHeartRate.h_prime / delta;
            const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 0;
            return {
                delta,
                minutes: minutes.toFixed(1)
            };
        })
        : [];

    if (loading) return <div className="container">Loading analysis...</div>;

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Training Analysis</h1>
                <p className="text-muted">Deep dive into your training intensity and effectiveness. {pastWorkoutsForDisplay.length > 0 && `(Latest ride: ${new Date([...pastWorkoutsForDisplay].sort((a, b) => new Date(b.date) - new Date(a.date))[0].date).toLocaleDateString()})`}</p>
            </header>

            {pastWorkoutsForDisplay.length === 0 ? (
                <div className="card" style={{ textAlign: 'center', padding: 'var(--space-2xl)' }}>
                    <Activity size={48} color="var(--text-secondary)" style={{ marginBottom: 'var(--space-md)' }} />
                    <h3 className="text-lg">No Data Available</h3>
                    <p className="text-muted">Upload workout files to see your analysis.</p>
                </div>
            ) : (
                <div className={styles.grid}>

                    {/* Strengths & Weaknesses */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Athlete Profile</h3>
                            <span className="text-sm text-muted">Analysis based on your power-to-weight ratio profile.</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-lg)' }}>
                            <div>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)', textTransform: 'uppercase' }}>Strengths</h4>
                                <ul style={{ listStyle: 'none', padding: 0 }}>
                                    {phenotype.strengths?.map(s => (
                                        <li key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#22c55e', fontWeight: 600 }}>
                                            <Zap size={16} /> {s}
                                        </li>
                                    )) || <li className="text-muted">Analyzing...</li>}
                                </ul>
                            </div>
                            <div>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)', textTransform: 'uppercase' }}>Focus Areas</h4>
                                <ul style={{ listStyle: 'none', padding: 0 }}>
                                    {phenotype.weaknesses?.map(w => (
                                        <li key={w} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                                            <TrendingUp size={16} /> {w}
                                        </li>
                                    )) || <li className="text-muted">Analyzing...</li>}
                                </ul>
                            </div>
                            <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: 'var(--space-lg)' }}>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)', textTransform: 'uppercase' }}>Phenotype</h4>
                                <p className="text-lg" style={{ fontWeight: 600 }}>{phenotype.type}</p>
                            </div>
                        </div>
                    </div>

                    {/* Critical Power Stats */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted">Best Critical Power (Last 6 Weeks)</span>
                                <div title="Best CP found in the rolling 6-week window, based on the strongest available 3min and 20min efforts using the Monod & Scherrer model." style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <Zap size={20} color="var(--accent-warning)" />
                        </div>
                        {criticalPower ? (
                            <>
                                <p className="text-xl">{criticalPower.cp} W</p>
                                <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                                    Probabilistic Range: {criticalPower.low}W - {criticalPower.high}W
                                </p>
                                <p className="text-sm text-muted" style={{ marginTop: '2px' }}>
                                    W' (Anaerobic Capacity): {(criticalPower.w_prime / 1000).toFixed(1)} kJ
                                </p>
                            </>
                        ) : (
                            <p className="text-muted">Need max efforts (3min & 20min) to detect.</p>
                        )}
                    </div>

                    {/* Critical Heart Rate (CHR) */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted">Critical Heart Rate</span>
                                <div title="Threshold-like HR estimate. Tolerance values below show expected time above CHR at fixed deltas (+5/+10/+15 bpm)." style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <Heart size={20} color="var(--accent-danger)" />
                        </div>
                        {criticalHeartRate ? (
                            <>
                                <p className="text-xl">{criticalHeartRate.chr} bpm</p>
                                <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                                    Above-threshold tolerance: +5 bpm | {hrToleranceRows[0]?.minutes} min, +10 bpm | {hrToleranceRows[1]?.minutes} min, +15 bpm | {hrToleranceRows[2]?.minutes} min
                                </p>
                                <p className="text-sm text-muted" style={{ marginTop: '2px' }}>
                                    Model reserve (H'): {criticalHeartRate.h_prime} beat-equivalents
                                </p>
                            </>
                        ) : (
                            <p className="text-muted">Need max efforts to detect.</p>
                        )}
                    </div>

                    {/* Estimated FTP */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted">FTP derived from FTP Test-like sessions</span>
                                <div title="95% of best 20min power" style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <TrendingUp size={20} color="var(--accent-primary)" />
                        </div>
                        <p className="text-xl">{currentUser?.profile.ftp} W</p>
                        <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                            Current Setting
                        </p>
                        <button
                            onClick={handleEstimateFtp}
                            className={styles.estimateBtn}
                            style={{
                                marginTop: 'var(--space-md)',
                                padding: '6px 12px',
                                fontSize: '0.875rem',
                                background: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}
                        >
                            <Calculator size={14} /> Update
                        </button>
                        {ftpSuggestion && (
                            <div style={{ marginTop: 'var(--space-md)', borderTop: '1px dashed var(--border-color)', paddingTop: 'var(--space-sm)' }}>
                                <p className="text-sm text-muted">Suggestion: {ftpSuggestion.reason}</p>
                                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                                    <button onClick={applyFtpSuggestion} className={styles.estimateBtn} style={{ padding: '6px 12px' }}>
                                        Apply suggested FTP ({ftpSuggestion.suggestedUpdate} W)
                                    </button>
                                    <button onClick={() => setFtpSuggestion(null)} className="text-muted" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Session Derived FTP */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted" style={{ fontSize: '0.85rem' }}>FTP derived from Interval Sessions</span>
                                <div title="Estimated from sustained intervals (>=8m) in the last 40% of long rides (>1h, >70 TSS) with <4% cardiac drift" style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <Zap size={20} color="#eab308" />
                        </div>
                        {sessionDerivedFtp ? (
                            <>
                                <p className="text-xl">{sessionDerivedFtp.low}W - {sessionDerivedFtp.high}W</p>
                                <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                                    Probability Range (95-100%)
                                </p>
                            </>
                        ) : (
                            <p className="text-muted" style={{ fontSize: '0.85rem' }}>No stable late-workout intervals detected yet.</p>
                        )}
                    </div>

                    {/* Performance Profile (W/kg vs benchmarks) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Performance Profile</h3>
                            <span className="text-sm text-muted">Relative strengths normalized to your strongest discipline (100 = your best).</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-lg)', alignItems: 'center' }}>
                            <div style={{ height: '260px', width: '100%' }}>
                                {profileData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={profileData} margin={{ top: 20, right: 20, left: 10, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                            <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                            <YAxis
                                                stroke="var(--text-secondary)"
                                                fontSize={12}
                                                tickLine={false}
                                                axisLine={false}
                                                domain={[0, 100]}
                                                ticks={[0, 25, 50, 75, 100]}
                                                tickFormatter={(v) => `${v}`}
                                                label={{ value: 'Normalized Score', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }}
                                            />
                                            <Tooltip content={<ProfileTooltip />} />
                                            <ReferenceLine y={100} stroke="#22c55e" strokeDasharray="3 3" label={{ value: 'Peak', position: 'right', fill: '#22c55e', fontSize: 11 }} />
                                            <ReferenceLine y={75} stroke="var(--border-color)" strokeDasharray="3 3" />
                                            <ReferenceLine y={50} stroke="var(--border-color)" strokeDasharray="3 3" />
                                            <ReferenceLine y={25} stroke="var(--border-color)" strokeDasharray="3 3" />
                                            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                                                {profileData.map((entry, i) => (
                                                    <Cell key={`cell-${i}`} fill={entry.color || '#7c3aed'} />
                                                ))}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>Not enough power data yet.</div>
                                )}
                            </div>
                            <div style={{ padding: 'var(--space-sm)' }}>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)' }}>Profile Level</h4>
                                <p style={{ fontSize: '1rem', fontWeight: 700 }}>{phenotype.performanceBreakdown?.overallLevel ? (shiftMap[phenotype.performanceBreakdown.overallLevel] || phenotype.performanceBreakdown.overallLevel) : 'Unknown'}</p>
                                <div style={{ marginTop: 'var(--space-md)' }}>
                                    <h5 className="text-sm text-muted">Per-Metric Categories</h5>
                                    <ul style={{ listStyle: 'none', padding: 0, marginTop: '6px' }}>
                                        <li><strong>5s:</strong> {phenotype.performanceBreakdown?.categories?.sprint ? (shiftMap[phenotype.performanceBreakdown.categories.sprint] || phenotype.performanceBreakdown.categories.sprint) : '—'}</li>
                                        <li><strong>1m:</strong> {phenotype.performanceBreakdown?.categories?.anaerobic ? (shiftMap[phenotype.performanceBreakdown.categories.anaerobic] || phenotype.performanceBreakdown.categories.anaerobic) : '—'}</li>
                                        <li><strong>5m:</strong> {phenotype.performanceBreakdown?.categories?.vo2max ? (shiftMap[phenotype.performanceBreakdown.categories.vo2max] || phenotype.performanceBreakdown.categories.vo2max) : '—'}</li>
                                        <li><strong>20m:</strong> {phenotype.performanceBreakdown?.categories?.threshold ? (shiftMap[phenotype.performanceBreakdown.categories.threshold] || phenotype.performanceBreakdown.categories.threshold) : '—'}</li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Power Duration Curve via Recharts */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Power Duration Curve (Last 6 Weeks)</h3>
                            <span className="text-sm text-muted">Peak power for key durations.</span>
                        </div>
                        <div style={{ height: '300px', width: '100%' }}>
                            {powerCurve.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={powerCurve} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                            cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                                        />
                                        <Line type="monotone" dataKey="allTimePower" name="All-Time" stroke="var(--text-muted)" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={true} />
                                        <Line type="monotone" dataKey="power" name="Last 6 Weeks" stroke="var(--accent-primary)" strokeWidth={2} dot={{ r: 4, fill: 'var(--accent-primary)' }} activeDot={{ r: 6 }} isAnimationActive={true} />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Not enough power data yet.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Aerobic Efficiency Trend (EF) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <h3 className="text-lg">Aerobic Efficiency Trend</h3>
                                <div title="Efficiency Factor (Normalized Power / Avg HR) for aerobic rides (IF ≤ 0.80, ≥ 30min). Rising trend = improved aerobic fitness." style={{ cursor: 'help', fontSize: '0.9em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <span className="text-sm text-muted">NP / HR per qualifying ride</span>
                        </div>
                        <div style={{ height: '250px', width: '100%' }}>
                            {efData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={efData} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis
                                            dataKey="label"
                                            stroke="var(--text-secondary)"
                                            fontSize={12}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis domain={['auto', 'auto']} stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontSize: '13px' }}
                                            cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                                            content={({ active, payload }) => {
                                                if (!active || !payload?.length) return null;
                                                const d = payload[0]?.payload;
                                                if (!d) return null;
                                                return (
                                                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px 14px', fontSize: '13px' }}>
                                                        <p style={{ fontWeight: 600, marginBottom: '4px' }}>{new Date(d.date).toLocaleDateString()}</p>
                                                        <p style={{ color: 'var(--text-muted)', marginBottom: '4px', fontStyle: 'italic' }}>{d.name}</p>
                                                        <p style={{ color: '#22c55e' }}>EF: {d.ef}</p>
                                                        <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>NP: {d.np}W &middot; HR: {d.hr}bpm</p>
                                                    </div>
                                                );
                                            }}
                                        />
                                        <Line type="monotone" dataKey="ef" name="Aerobic Efficiency" stroke="#22c55e" strokeWidth={2} dot={{ r: 3, fill: '#22c55e' }} activeDot={{ r: 5 }} connectNulls />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Need more aerobic rides (IF ≤ 0.80, ≥ 30min) to show trend.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Recovery Trend (Last 6 Weeks) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <h3 className="text-lg">Recovery Trend (Last 6 Weeks)</h3>
                                <div title="Sleep, HRV, and weekly TSS are normalized to 0–100% across the window for easy comparison. Hover for real values." style={{ cursor: 'help', fontSize: '0.9em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <span className="text-sm text-muted">Normalized view — hover for real values</span>
                        </div>
                        <div style={{ height: '320px', width: '100%' }}>
                            {multiTrendData.length > 0 && multiTrendData.some(d => d.hrv || d.sleep || d.tss) ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={multiTrendData} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis dataKey="week" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis domain={[0, 100]} stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontSize: '13px' }}
                                            cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                                            content={({ active, payload, label }) => {
                                                if (!active || !payload?.length) return null;
                                                const d = payload[0]?.payload;
                                                if (!d) return null;
                                                return (
                                                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px 14px', fontSize: '13px' }}>
                                                        <p style={{ fontWeight: 600, marginBottom: '6px' }}>Week of {label}</p>
                                                        {d._rawHrv != null && <p style={{ color: '#a78bfa' }}>HRV: {d._rawHrv} ms</p>}
                                                        {d._rawSleep != null && <p style={{ color: '#38bdf8' }}>Sleep Score: {d._rawSleep}</p>}
                                                        {d._rawTss != null && <p style={{ color: '#f59e0b' }}>Weekly TSS: {d._rawTss}</p>}
                                                    </div>
                                                );
                                            }}
                                        />
                                        <Legend
                                            wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                                            formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
                                        />
                                        <Line type="monotone" dataKey="hrv" name="HRV" stroke="#a78bfa" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                                        <Line type="monotone" dataKey="sleep" name="Sleep" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                                        <Line type="monotone" dataKey="tss" name="Weekly TSS" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Need workout and daily metric data to show trends.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Rolling 4-Week Maximum Trend (Last 3 Months) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <h3 className="text-lg">Rolling 4-Week Maximum Trend (Last 3 Months)</h3>
                                <div title="Each point shows the normalized rolling 4-week maximum for each metric across the last 3 months. Hover to see real values." style={{ cursor: 'help', fontSize: '0.9em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <span className="text-sm text-muted">Normalized rolling 4-week maxima — hover for real values</span>
                        </div>
                        <div style={{ height: '320px', width: '100%' }}>
                            {baselineTrendData.length > 0 && baselineTrendData.some(d => d.cp != null || d.p1m != null || d.p5m != null || d.p20m != null || d.intervalFtp != null) ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <ComposedChart data={baselineTrendData} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis dataKey="week" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis domain={[0, 100]} stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontSize: '13px' }}
                                            cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                                            content={({ active, payload, label }) => {
                                                if (!active || !payload?.length) return null;
                                                const d = payload[0]?.payload;
                                                if (!d) return null;
                                                return (
                                                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px 14px', fontSize: '13px' }}>
                                                        <p style={{ fontWeight: 600, marginBottom: '6px' }}>Week of {label}</p>
                                                        {d._rawCp != null && <p style={{ color: '#f59e0b' }}>CP (4w max): {d._rawCp}W</p>}
                                                        {d._raw1m != null && <p style={{ color: '#ef4444' }}>1min (4w max): {d._raw1m}W</p>}
                                                        {d._raw5m != null && <p style={{ color: '#22c55e' }}>5min (4w max): {d._raw5m}W</p>}
                                                        {d._raw20m != null && <p style={{ color: '#3b82f6' }}>20min (4w max): {d._raw20m}W</p>}
                                                        {d._rawIntervalFtp != null && <p style={{ color: '#ec4899' }}>FTP from intervals (4w max): {d._rawIntervalFtp}W</p>}
                                                    </div>
                                                );
                                            }}
                                        />
                                        <Legend
                                            wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                                            formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
                                        />
                                        <Line type="monotone" dataKey="cp" name="CP (4w max)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                                        <Line type="monotone" dataKey="p1m" name="1min (4w max)" stroke="#ef4444" strokeWidth={1.5} dot={{ r: 2 }} strokeDasharray="4 2" connectNulls />
                                        <Line type="monotone" dataKey="p5m" name="5min (4w max)" stroke="#22c55e" strokeWidth={1.5} dot={{ r: 2 }} strokeDasharray="4 2" connectNulls />
                                        <Line type="monotone" dataKey="p20m" name="20min (4w max)" stroke="#3b82f6" strokeWidth={1.5} dot={{ r: 2 }} strokeDasharray="4 2" connectNulls />
                                        <Line type="monotone" dataKey="intervalFtp" name="FTP (Intervals, 4w max)" stroke="#ec4899" strokeWidth={1.8} dot={{ r: 2 }} strokeDasharray="2 2" connectNulls />
                                    </ComposedChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Need workout and daily metric data to show rolling maximum trends.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Weekly TSS (Actual vs Planned) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <h3 className="text-lg">Weekly TSS: Last 12 Weeks + Planned</h3>
                                <div title="Blue bars: actual weekly TSS for the last 12 weeks. Amber bars: projected weekly TSS from future planned rides in the calendar." style={{ cursor: 'help', fontSize: '0.9em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <span className="text-sm text-muted">Past load vs future planned load</span>
                        </div>
                        <div style={{ height: '300px', width: '100%' }}>
                            {weeklyTssData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={weeklyTssData} margin={{ top: 20, right: 30, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis dataKey="week" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} label={{ value: 'TSS / week', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                            formatter={(value, name) => [value ?? '—', name === 'actualTss' ? 'Actual TSS' : 'Projected TSS']}
                                        />
                                        <Legend formatter={(value) => (value === 'actualTss' ? 'Actual TSS' : 'Projected TSS')} />
                                        <Bar dataKey="actualTss" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                                        <Bar dataKey="projectedTss" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Not enough data to render weekly TSS.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Time in Zones Chart */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Time in Zones (Last 4 Weeks)</h3>
                            <span className="text-sm text-muted">Minutes spent in each intensity zone</span>
                        </div>
                        <div style={{ height: '250px', width: '100%' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={zoneData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                    <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                        itemStyle={{ color: 'var(--text-primary)' }}
                                        cursor={{ fill: 'var(--bg-tertiary)' }}
                                    />
                                    <Bar dataKey="time" radius={[4, 4, 0, 0]}>
                                        {zoneData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.color} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Training DNA - Stacked Area Chart */}
                    {dnaData?.weeklyTrends?.length > 0 && (
                        <div className="card" style={{ gridColumn: '1 / -1' }}>
                            <div className={styles.cardHeader}>
                                <h3 className="text-lg">Training Distribution (Last 12 Weeks)</h3>
                                <span className="text-sm text-muted">Weekly total hours by intensity zone</span>
                            </div>
                            <div style={{ height: '280px', width: '100%' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={dnaData.weeklyTrends} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis dataKey="weekLabel" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} label={{ value: 'Hours', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                                            itemStyle={{ color: 'var(--text-primary)' }}
                                            formatter={(value, name) => [typeof value === 'number' ? value.toFixed(2) : value, name]}
                                        />
                                        <Legend wrapperStyle={{ paddingTop: '10px' }} />
                                        <Line type="monotone" dataKey="Recovery" name="Recovery" stroke="#888888" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="Endurance" name="Endurance" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="Tempo" name="Tempo" stroke="#22c55e" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="Threshold" name="Threshold" stroke="#eab308" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="VO2Max" name="VO2Max" stroke="#f97316" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="Anaerobic" name="Anaerobic" stroke="#ef4444" strokeWidth={2} dot={{ r: 2 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}

                </div>
            )}

            <Modal
                isOpen={isFtpModalOpen}
                onClose={() => setIsFtpModalOpen(false)}
                title="FTP Estimation"
            >
                <div style={{ padding: 'var(--space-md)' }}>
                    <p style={{ marginBottom: 'var(--space-lg)', lineHeight: '1.5' }}>{ftpMessage}</p>
                    {estimatedFtp && (
                        <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setIsFtpModalOpen(false)}
                                style={{ padding: '8px 16px', borderRadius: '4px', background: 'transparent', border: '1px solid var(--border-color)', cursor: 'pointer', color: 'var(--text-primary)' }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmFtpUpdate}
                                style={{ padding: '8px 16px', borderRadius: '4px', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                            >
                                Accept {estimatedFtp}W
                            </button>
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
};

export default Analysis;
