import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useUser } from '../context/UserContext';
import { db, getLocalDayKey } from '../utils/db';
import { calculateTimeInZones, calculateTrainingDNA } from '../utils/analysis';
import { analyzeAdaptations, generateRecommendation } from '../utils/intelligence';
import { subDays, startOfDay, startOfWeek, endOfDay, addDays, format } from 'date-fns';
import { TrendingUp, Clock, Target, ArrowRight, Brain, Zap, Activity } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line } from 'recharts';
import styles from './FutureTraining.module.css';

const formatHoursToHrMin = (hours) => {
    const totalMinutes = Math.round((hours || 0) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${m.toString().padStart(2, '0')}`;
};

const DAY_SLOTS = {
    1: [2],
    2: [0, 3],
    3: [0, 2, 4],
    4: [0, 1, 3, 5],
    5: [0, 1, 2, 4, 5],
    6: [0, 1, 2, 3, 4, 5],
    7: [0, 1, 2, 3, 4, 5, 6]
};

const getDaySlots = (count) => DAY_SLOTS[Math.min(7, Math.max(1, count))] || DAY_SLOTS[5];
const PLAN_SCHEMA_VERSION = 7;

const normalizeConstraintReduction = (value) => {
    const raw = Number(value || 0);
    const normalized = raw > 1 ? (raw / 100) : raw;
    return Math.max(0, Math.min(0.8, normalized));
};

const resolveConstraintDayPolicy = (matches = []) => {
    if (!matches.length) {
        return { mode: 'none', reduction: 0, hasRace: false, hasTaper: false };
    }

    const enriched = matches.map((constraint) => ({
        precedence: getConstraintPrecedence(constraint),
        type: String(constraint?.type || '').toLowerCase(),
        hardBlock: getConstraintPrecedence(constraint) === 'hard' && constraint?.blockTraining !== false,
        reduction: normalizeConstraintReduction(constraint?.reduceAvailability || 0),
    }));

    const hasRace = enriched.some(c => c.type === 'race');
    const hasTaper = enriched.some(c => c.type === 'taper');
    const hasHardBlock = enriched.some(c => c.hardBlock);
    const maxSoftReduction = enriched.reduce((acc, c) => c.precedence === 'soft' ? Math.max(acc, c.reduction) : acc, 0);

    // Deterministic precedence when overlaps exist on the same day:
    // hard block > race > taper > soft.
    if (hasHardBlock) {
        return {
            mode: 'block',
            reduction: 0,
            hasRace,
            hasTaper,
        };
    }

    if (hasRace) {
        return {
            mode: 'race',
            reduction: Math.max(maxSoftReduction, 0.2),
            hasRace,
            hasTaper,
        };
    }

    if (hasTaper) {
        return {
            mode: 'taper',
            reduction: Math.max(maxSoftReduction, 0.35),
            hasRace,
            hasTaper,
        };
    }

    return {
        mode: maxSoftReduction > 0 ? 'soft' : 'none',
        reduction: maxSoftReduction,
        hasRace,
        hasTaper,
    };
};

const expandWeekSessions = (sessions = []) => {
    const expanded = [];
    sessions.forEach(session => {
        const count = Math.max(1, Number(session.count) || 1);
        for (let i = 0; i < count; i++) {
            expanded.push({
                ...session,
                count: 1,
                totalWeekly: session.hoursPerSession,
            });
        }
    });
    return expanded;
};

const buildDayByDayPlan = (fourWeekPlan, currentUser) => {
    if (!fourWeekPlan?.weeks?.length || !currentUser) return [];

    const planStart = addDays(startOfWeek(startOfDay(new Date()), { weekStartsOn: 1 }), 7);
    const ftp = currentUser.profile?.ftp || 250;
    const rows = [];

    fourWeekPlan.weeks.forEach((week, weekIndex) => {
        const expanded = expandWeekSessions(week.sessions || []);
        const slots = getDaySlots(expanded.length);
        const weekStart = addDays(planStart, weekIndex * 7);

        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
            const date = addDays(weekStart, dayOffset);
            const sessionIndex = slots.indexOf(dayOffset);
            const session = sessionIndex >= 0 ? expanded[sessionIndex] : null;

            if (!session) {
                rows.push({
                    weekNumber: week.weekNumber,
                    date,
                    dayLabel: format(date, 'EEE'),
                    isRest: true,
                });
                continue;
            }

            const detail = session.intervalDetails;
            const targetAvg = detail
                ? Math.round((detail.powerLow + detail.powerHigh) / 2)
                : Math.round(ftp * 0.65);

            rows.push({
                weekNumber: week.weekNumber,
                date,
                dayLabel: format(date, 'EEE'),
                isRest: false,
                workout: {
                    title: `${session.type} Session`,
                    type: session.type,
                    durationSec: Math.round((session.hoursPerSession || 0) * 3600),
                    intervalDetails: detail || null,
                    intervalZone: session.intervalZone || null,
                    targetAvg,
                }
            });
        }
    });

    return rows;
};

const normalizeConstraintDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return getLocalDayKey(d);
};

const getConstraintPrecedence = (constraint) => {
    const explicit = String(constraint?.precedence || '').toLowerCase();
    if (explicit === 'hard' || explicit === 'soft') return explicit;

    const type = String(constraint?.type || '').toLowerCase();
    if (['illness', 'sick', 'travel', 'holiday', 'unavailable'].includes(type)) return 'hard';
    return 'soft';
};

const getConstraintMatchesForDate = (date, constraints = []) => {
    const dayKey = normalizeConstraintDate(date);
    if (!dayKey) return [];
    return constraints.filter(constraint => {
        const startKey = normalizeConstraintDate(constraint.startDate);
        const endKey = normalizeConstraintDate(constraint.endDate || constraint.startDate);
        if (!startKey || !endKey) return false;
        return dayKey >= startKey && dayKey <= endKey;
    });
};

const getConstraintDisplayLabel = (constraint) => {
    const title = String(constraint?.title || '').trim();
    if (title) return title;
    const type = String(constraint?.type || 'constraint');
    return type.charAt(0).toUpperCase() + type.slice(1);
};

const FutureTraining = () => {
    const { currentUser } = useUser();
    const [workouts, setWorkouts] = useState([]);
    const [recommendation, setRecommendation] = useState(null);
    const [target, setTarget] = useState('');
    const [trainingApproach, setTrainingApproach] = useState('suggested');
    const [restWeekCadence, setRestWeekCadence] = useState(4);
    const [autoSyncCalendar, setAutoSyncCalendar] = useState(true);
    const [availHours, setAvailHours] = useState(6);
    const [daysAvailable, setDaysAvailable] = useState(5);
    const [successProfile, setSuccessProfile] = useState(null);
    const [dnaData, setDnaData] = useState(null);
    const [adaptationAnalysis, setAdaptationAnalysis] = useState(null);
    const [constraints, setConstraints] = useState([]);
    const [newConstraint, setNewConstraint] = useState({
        title: '',
        type: 'travel',
        startDate: '',
        endDate: '',
        precedence: 'hard',
        blockTraining: true,
        reduceAvailability: 0.3,
    });
    const [isPublishingPlan, setIsPublishingPlan] = useState(false);
    const [publishStatus, setPublishStatus] = useState('');

    // Ref to track the settings of the last saved plan (avoids redundant regeneration)
    const lastSavedPlan = useRef(null);

    const refreshData = useCallback(async () => {
        if (!currentUser) return;
        const workoutData = await db.getWorkouts(currentUser.id);
        const metricsData = await db.getMetrics(currentUser.id);
        const constraintsData = await db.getConstraints(currentUser.id);
        setWorkouts(workoutData || []);
        setConstraints(constraintsData || []);

        const dna = calculateTrainingDNA(workoutData || [], metricsData || [], currentUser.profile?.ftp);
        setDnaData(dna);

        const analysis = analyzeAdaptations(workoutData || [], metricsData || [], []);
        setAdaptationAnalysis(analysis);
    }, [currentUser]);

    useEffect(() => {
        refreshData();
    }, [refreshData]);

    useEffect(() => {
        if (!currentUser) return undefined;

        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                refreshData();
            }
        };

        const intervalId = window.setInterval(() => {
            refreshData();
        }, 5 * 60 * 1000);

        window.addEventListener('focus', refreshData);
        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('training-data-updated', refreshData);

        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener('focus', refreshData);
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('training-data-updated', refreshData);
        };
    }, [currentUser, refreshData]);

    const dataSignature = useMemo(() => workouts
        .filter(w => !(w.plan_source === 'four_week' && (w.completion_status || 'planned') === 'planned' && w.completed !== true))
        .map(w => [
            w.id,
            w.date,
            w.completion_status || '',
            w.completed ? 1 : 0,
            w.execution_success ? 1 : 0,
            w.success_score || '',
            w.rpe || '',
            w.feeling_strength || '',
            w.structured_reps || '',
            w.structured_interval_mins || '',
            w.structured_power_low || ''
        ].join(':'))
        .sort()
        .join('|'), [workouts]);

    const constraintSignature = useMemo(() => (constraints || [])
        .map(c => [
            c.id,
            c.type || '',
            c.startDate || '',
            c.endDate || '',
            c.precedence || '',
            c.blockTraining ? 1 : 0,
            Number(c.reduceAvailability || 0)
        ].join(':'))
        .sort()
        .join('|'), [constraints]);

    // Restore saved plan settings (and recommendation if still fresh) from localStorage
    useEffect(() => {
        if (!currentUser) return;
        try {
            const stored = JSON.parse(localStorage.getItem(`training_plan_${currentUser.id}`));
            if (!stored) return;
            // Always restore the user's settings regardless of age
            if (stored.target)        setTarget(stored.target);
            if (stored.trainingApproach) setTrainingApproach(stored.trainingApproach);
            if (stored.restWeekCadence) setRestWeekCadence(Number(stored.restWeekCadence));
            if (typeof stored.autoSyncCalendar === 'boolean') setAutoSyncCalendar(stored.autoSyncCalendar);
            if (stored.availHours)    setAvailHours(stored.availHours);
            if (stored.daysAvailable) setDaysAvailable(stored.daysAvailable);
            const fourWeeksMs = 28 * 24 * 60 * 60 * 1000;
            const isRecent = stored.generatedAt && (Date.now() - new Date(stored.generatedAt)) < fourWeeksMs;
            const isCurrentSchema = (stored.planSchemaVersion || 1) === PLAN_SCHEMA_VERSION;
            if (isRecent && isCurrentSchema && stored.recommendation) {
                setRecommendation(stored.recommendation);
                lastSavedPlan.current = {
                    target: stored.target,
                    trainingApproach: stored.trainingApproach || 'suggested',
                    restWeekCadence: Number(stored.restWeekCadence || 4),
                    availHours: stored.availHours,
                    daysAvailable: stored.daysAvailable,
                    dataSignature: stored.dataSignature,
                    constraintSignature: stored.constraintSignature || '',
                    generatedAt: stored.generatedAt,
                };
            }
        } catch { /* ignore corrupt cache */ }
    }, [currentUser]);

    // 1. Analyze Success Patterns
    useMemo(() => {
        if (!workouts.length || !currentUser) return;
        const ftp = currentUser.profile.ftp;

        // Find Star Periods (same logic as Calendar)
        const starDates = [];
        // Iterate all relevant days (optimization: just check days with existing workouts as end-points?)
        // Let's iterate sorted workouts dates.
        const sorted = [...workouts].sort((a, b) => new Date(a.date) - new Date(b.date));
        if (!sorted.length) return;

        const first = new Date(sorted[0].date);
        const last = new Date(sorted[sorted.length - 1].date);

        // Scan every day? Maybe expensive. Let's scan every workout date.
        // A Star Period is defined by the day it completes.
        const starBlocks = [];

        for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
            const day = new Date(d);
            const winStart = subDays(day, 6);

            const valid = workouts.filter(w => {
                const wd = new Date(w.date);
                return wd >= winStart && wd <= endOfDay(day);
            });

            const highFeeling = valid.filter(w => (w.feeling_strength || 0) >= 8).length;

            if (highFeeling >= 3) {
                // Found a Star Period. Analyze the PRECEDING 6 WEEKS leading up to this success.
                const blockEnd = day;
                const blockStart = subDays(day, 42);

                const blockWorkouts = workouts.filter(w => {
                    const wd = new Date(w.date);
                    return wd >= blockStart && wd <= blockEnd;
                });

                // Calc Stats
                const totalSecs = blockWorkouts.reduce((acc, w) => acc + (w.total_elapsed_time || 0), 0);
                const avgHrs = (totalSecs / 3600) / 6;

                // Zone Dist
                const zTimes = [0, 0, 0, 0, 0, 0, 0];
                blockWorkouts.forEach(w => {
                    if (w.streams) {
                        const z = calculateTimeInZones(w.streams, ftp);
                        z.forEach((zone, i) => zTimes[i] += zone.time);
                    }
                });

                const totalZTime = zTimes.reduce((a, b) => a + b, 0) || 1;
                const zDist = zTimes.map(t => t / totalZTime); // percentages

                starBlocks.push({ avgHrs, zDist, date: day });
            }
        }

        if (starBlocks.length > 0) {
            // Average the profiles of all star blocks
            const avgHrs = starBlocks.reduce((acc, b) => acc + b.avgHrs, 0) / starBlocks.length;
            const avgZDist = [0, 0, 0, 0, 0, 0, 0];
            starBlocks.forEach(b => {
                b.zDist.forEach((p, i) => avgZDist[i] += p);
            });
            const finalZDist = avgZDist.map(t => (t / starBlocks.length) * 100); // 0-100 scale

            setSuccessProfile({
                avgHrs: avgHrs.toFixed(1),
                zDist: finalZDist,
                count: starBlocks.length
            });
        }

    }, [workouts, currentUser]);

    // 2. Generate Recommendation
    // 2. Generate, display, and persist the recommendation
    const savePlanRowsToCalendar = useCallback(async (rows, options = {}) => {
        if (!currentUser || !rows?.length) return 0;

        const statusPrefix = String(options.statusPrefix || 'Publishing');
        const chunkSize = Math.max(5, Number(options.chunkSize || 25));

        const runChunked = async (items, worker, phaseLabel) => {
            if (!items.length) return;
            let processed = 0;
            for (let i = 0; i < items.length; i += chunkSize) {
                const chunk = items.slice(i, i + chunkSize);
                await Promise.all(chunk.map(worker));
                processed += chunk.length;
                setPublishStatus(`${statusPrefix}: ${phaseLabel} ${processed}/${items.length}`);
            }
        };

        const constrainedRows = rows.map((row) => {
            const matches = getConstraintMatchesForDate(row.date, constraints);
            if (!matches.length || row.isRest || !row.workout) return row;

            const dayPolicy = resolveConstraintDayPolicy(matches);
            if (dayPolicy.mode === 'block') {
                return {
                    ...row,
                    isRest: true,
                    workout: null,
                };
            }

            const maxReduction = dayPolicy.reduction || 0;

            if (maxReduction <= 0) return row;

            const durationFactor = 1 - maxReduction;
            const powerFactor = 1 - (maxReduction * 0.45);
            const adjustedDuration = Math.max(30 * 60, Math.round((row.workout.durationSec || 0) * durationFactor));
            const adjustedTarget = Math.max(80, Math.round((row.workout.targetAvg || 0) * powerFactor));
            const details = row.workout.intervalDetails;

            const adjustedDetails = details ? {
                ...details,
                powerLow: Math.max(60, Math.round((details.powerLow || adjustedTarget) * powerFactor)),
                powerHigh: Math.max(70, Math.round((details.powerHigh || (adjustedTarget + 10)) * powerFactor)),
            } : null;

            return {
                ...row,
                workout: {
                    ...row.workout,
                    durationSec: adjustedDuration,
                    targetAvg: adjustedTarget,
                    intervalDetails: adjustedDetails,
                }
            };
        });

        const replaceFromWeek = Number(options.replaceFromWeek || 1);
        const all = await db.getWorkouts(currentUser.id);
        const today = startOfDay(new Date());

        const replaceable = all.filter(w =>
            w.plan_source === 'four_week' &&
            Number(w.plan_week_number || 0) >= replaceFromWeek &&
            new Date(w.date) >= today &&
            (w.completion_status || 'planned') !== 'completed'
        );

        await runChunked(replaceable, (w) => db.deleteWorkout(w.id), 'clearing old rides');

        const toCreate = constrainedRows.filter(d => !d.isRest && d.workout && Number(d.weekNumber || 0) >= replaceFromWeek);
        const payloads = toCreate.map((d) => {
            const detail = d.workout.intervalDetails;
            const payload = {
                userId: currentUser.id,
                date: d.date.toISOString(),
                title: d.workout.title,
                total_elapsed_time: d.workout.durationSec,
                total_distance: 0,
                avg_power: d.workout.targetAvg,
                normalized_power: d.workout.targetAvg,
                intensity_factor: d.workout.targetAvg / (currentUser.profile?.ftp || 250),
                planned: true,
                completed: false,
                completion_status: 'planned',
                plan_source: 'four_week',
                plan_week_number: d.weekNumber,
                planned_interval_zone: d.workout.intervalZone,
                structured_reps: detail?.reps || null,
                structured_interval_mins: detail?.intervalMins || null,
                structured_rest_mins: detail?.restMins || null,
                structured_power_low: detail?.powerLow || null,
                structured_power_high: detail?.powerHigh || null,
                structured_target_avg: detail ? Math.round((detail.powerLow + detail.powerHigh) / 2) : d.workout.targetAvg,
            };

            const ftp = currentUser.profile?.ftp || 250;
            const targetAvg = payload.structured_target_avg || payload.avg_power || 0;
            const ifVal = ftp > 0 ? targetAvg / ftp : 0;
            payload.expected_tss = ftp > 0
                ? Math.round(((payload.total_elapsed_time * targetAvg * ifVal) / (ftp * 36)) * 10) / 10
                : null;

            return payload;
        });

        await runChunked(payloads, (payload) => db.addWorkout(payload), 'adding new rides');

        return toCreate.length;
    }, [currentUser, constraints]);

    const addConstraint = useCallback(async () => {
        if (!currentUser) return;
        const start = normalizeConstraintDate(newConstraint.startDate);
        const end = normalizeConstraintDate(newConstraint.endDate || newConstraint.startDate);
        if (!start || !end) {
            setPublishStatus('Constraint requires a valid start/end date.');
            return;
        }
        await db.addConstraint({
            userId: currentUser.id,
            title: String(newConstraint.title || '').trim() || `${newConstraint.type} constraint`,
            type: newConstraint.type,
            startDate: start,
            endDate: end,
            precedence: newConstraint.precedence,
            blockTraining: newConstraint.precedence === 'hard' ? true : Boolean(newConstraint.blockTraining),
            reduceAvailability: Number(newConstraint.reduceAvailability || 0),
        });
        setNewConstraint(prev => ({ ...prev, title: '' }));
        setPublishStatus('Constraint added. Plan will auto-adjust on next regeneration.');
    }, [currentUser, newConstraint]);

    const removeConstraint = useCallback(async (id) => {
        await db.deleteConstraint(id);
        setPublishStatus('Constraint removed.');
    }, []);

    const generateAndSavePlan = useCallback(async (options = {}) => {
        if (!target || !currentUser) return;
        const analysis = adaptationAnalysis || { insufficientData: true };
        const plannerStartDate = addDays(startOfWeek(startOfDay(new Date()), { weekStartsOn: 1 }), 7);
        const rec = generateRecommendation(
            analysis,
            currentUser.profile,
            target,
            availHours,
            daysAvailable,
            workouts,
            trainingApproach,
            {
                restWeekCadence,
                constraints,
                planStartDate: plannerStartDate.toISOString(),
            }
        );
        const recData = {
            title: rec.title,
            description: rec.description,
            focusZones: rec.focusZones,
            weeklyPlan: rec.weeklyPlan,
            fourWeekPlan: rec.fourWeekPlan,
            suggestedApproach: rec.suggestedApproach,
            trainingApproach: rec.trainingApproach,
            plannerSettings: rec.plannerSettings,
        };
        setRecommendation(recData);
        const planData = {
            target,
            trainingApproach,
            restWeekCadence,
            autoSyncCalendar,
            availHours,
            daysAvailable,
            planSchemaVersion: PLAN_SCHEMA_VERSION,
            dataSignature,
            constraintSignature,
            generatedAt: new Date().toISOString(),
            recommendation: recData,
        };
        localStorage.setItem(`training_plan_${currentUser.id}`, JSON.stringify(planData));
        lastSavedPlan.current = planData;

        const isAutoRegeneration = options.autoRegeneration === true;
        if (isAutoRegeneration && autoSyncCalendar) {
            const hasFutureGenerated = workouts.some(w =>
                w.plan_source === 'four_week'
                && (w.completion_status || 'planned') === 'planned'
                && w.completed !== true
                && new Date(w.date) >= startOfDay(new Date())
            );
            if (hasFutureGenerated) {
                const rows = buildDayByDayPlan(recData.fourWeekPlan, currentUser);
                const created = await savePlanRowsToCalendar(rows, { replaceFromWeek: 3, statusPrefix: 'Auto-update' });
                if (created > 0) {
                    setPublishStatus(`Auto-updated ${created} future planned rides (weeks 3-8).`);
                }
            }
        }
    }, [
        target,
        trainingApproach,
        restWeekCadence,
        autoSyncCalendar,
        currentUser,
        adaptationAnalysis,
        availHours,
        daysAvailable,
        workouts,
        constraints,
        savePlanRowsToCalendar,
        dataSignature,
        constraintSignature
    ]);

    // Auto-generate when analysis is ready and settings differ from saved plan (or plan has expired)
    useEffect(() => {
        if (!adaptationAnalysis || !target || !currentUser) return;
        const saved = lastSavedPlan.current;
        const fourWeeksMs = 28 * 24 * 60 * 60 * 1000;
        const isExpired   = !saved?.generatedAt || (Date.now() - new Date(saved.generatedAt)) >= fourWeeksMs;
        const isDifferent = !saved?.recommendation ||
            saved.target !== target ||
            saved.trainingApproach !== trainingApproach ||
            saved.restWeekCadence !== restWeekCadence ||
            saved.availHours !== availHours ||
            saved.daysAvailable !== daysAvailable ||
            saved.dataSignature !== dataSignature ||
            saved.constraintSignature !== constraintSignature;
        if (isExpired || isDifferent) {
            generateAndSavePlan({ autoRegeneration: true });
        }
    }, [adaptationAnalysis, target, trainingApproach, restWeekCadence, availHours, daysAvailable, currentUser, generateAndSavePlan, dataSignature, constraintSignature]);

    const dayByDayPlan = useMemo(() => buildDayByDayPlan(recommendation?.fourWeekPlan, currentUser), [recommendation, currentUser]);

    const dayConstraintMatches = useMemo(() => dayByDayPlan.map((day) => (
        getConstraintMatchesForDate(day.date, constraints)
    )), [dayByDayPlan, constraints]);

    const weeklyConstraintMap = useMemo(() => {
        const map = new Map();
        dayByDayPlan.forEach((day) => {
            const weekNumber = Number(day.weekNumber || 0);
            if (!weekNumber) return;
            const matches = getConstraintMatchesForDate(day.date, constraints);
            if (!matches.length) return;

            if (!map.has(weekNumber)) map.set(weekNumber, new Map());
            const weekMap = map.get(weekNumber);
            matches.forEach((constraint) => {
                const fallbackId = `${constraint.type || 'constraint'}:${constraint.startDate || ''}:${constraint.endDate || ''}:${constraint.title || ''}`;
                weekMap.set(constraint.id ?? fallbackId, constraint);
            });
        });

        return map;
    }, [dayByDayPlan, constraints]);

    const publishPlanToCalendar = useCallback(async () => {
        if (!currentUser || !dayByDayPlan.length) return;
        setIsPublishingPlan(true);
        setPublishStatus('');

        try {
            const created = await savePlanRowsToCalendar(dayByDayPlan, { replaceFromWeek: 1, statusPrefix: 'Publishing' });
            setPublishStatus(`Added ${created} planned rides to calendar.`);
        } catch {
            setPublishStatus('Could not publish plan to calendar. Please try again.');
        } finally {
            setIsPublishingPlan(false);
        }
    }, [currentUser, dayByDayPlan, savePlanRowsToCalendar]);

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Future Training</h1>
                <p className="text-muted">Analyze your successful habits and plan your next phase.</p>
            </header>

            <div className={styles.grid}>

                {/* 1. Success DNA */}
                <div className={styles.biocard}>
                    <div className={styles.cardHeader}>
                        <Brain size={24} color="var(--accent-primary)" />
                        <h3>Your Training DNA</h3>
                    </div>
                    {dnaData ? (
                        <div className={styles.dnaContent}>
                            <p className="text-sm text-muted" style={{ marginBottom: '1.5rem' }}>
                                12-week workout distribution (3-week rolling average):
                            </p>

                            <div style={{ width: '100%', height: 300, marginBottom: '2rem' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={dnaData.weeklyTrends}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                                        <XAxis dataKey="weekLabel" stroke="var(--text-secondary)" fontSize={12} />
                                        <YAxis stroke="var(--text-secondary)" fontSize={12} label={{ value: 'Hours (Avg)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                                            itemStyle={{ color: 'var(--text-primary)' }}
                                            formatter={(value, name) => [typeof value === 'number' ? value.toFixed(2) : value, name]}
                                        />
                                        <Legend wrapperStyle={{ paddingTop: '10px' }} />
                                        <Line type="monotone" dataKey="RecoveryRolling" name="Recovery" stroke="#888888" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="EnduranceRolling" name="Endurance" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="TempoRolling" name="Tempo" stroke="#22c55e" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="ThresholdRolling" name="Threshold" stroke="#eab308" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="VO2MaxRolling" name="VO2Max" stroke="#f97316" strokeWidth={2} dot={{ r: 2 }} />
                                        <Line type="monotone" dataKey="AnaerobicRolling" name="Anaerobic" stroke="#ef4444" strokeWidth={2} dot={{ r: 2 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>

                            <div className={styles.averagesSection}>
                                <div className={styles.avgStat}>
                                    <span className={styles.avgVal}>{dnaData.longTermAverages.tssPerWeek}</span>
                                    <label>Avg Weekly TSS <small>(12w)</small></label>
                                </div>
                                <div className={styles.avgStat}>
                                    <span className={styles.avgVal}>{dnaData.longTermAverages.hrsPerWeek}h</span>
                                    <label>Avg Weekly Vol <small>(12w)</small></label>
                                </div>
                            </div>

                            <div style={{ borderTop: '1px solid var(--border-color)', margin: 'var(--space-xl) 0', paddingTop: 'var(--space-lg)' }}>
                                {dnaData.winningFormula ? (
                                    <>
                                        <h4 className="text-xs text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-md)', letterSpacing: '0.05em' }}>Winning Formula (Lead-up to Peak)</h4>
                                        <div className={styles.formulaGrid}>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.tssPerWeek}</span>
                                                <label>TSS / Week</label>
                                            </div>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.hrsPerWeek}h</span>
                                                <label>Volume / Week</label>
                                            </div>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.sleepPerDay}h</span>
                                                <label>Sleep / Day</label>
                                            </div>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.hrvPerDay}</span>
                                                <label>HRV / Day</label>
                                            </div>
                                        </div>

                                        <div className={styles.distributionSection} style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                                            <h4 className="text-xs text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-md)', letterSpacing: '0.05em' }}>Peak Session Mix</h4>
                                            <div className={styles.distGrid}>
                                                {Object.entries(dnaData.winningFormula.distribution).map(([type, hrs]) => (
                                                    <div key={type} className={styles.distItem}>
                                                        <span className={styles.distCount}>{hrs}h</span>
                                                        <span className={styles.distLabel}>{type}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                                        <p className="text-sm">
                                            <strong>Winning Formula Analysis:</strong><br />
                                            {dnaData.bestWeekStart ?
                                                `Your best week was around ${dnaData.bestWeekStart} (Feeling: ${dnaData.avgFeeling}/10), but we need more history to analyze the lead-up.` :
                                                "No clear 'Peak Week' detected in the last 3 months (High Volume + High Feeling)."}
                                            <br /><span style={{ fontSize: '0.8em', opacity: 0.8 }}>Keep logging rides and feeling scores to unlock this section!</span>
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-center" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                            <p>No workout data available for analysis.</p>
                        </div>
                    )}
                </div>

                {/* 2. Planner Form */}
                <div className={styles.formCard}>
                    <div className={styles.cardHeader}>
                        <Target size={24} color="var(--accent-secondary)" />
                        <h3>Set Your Goals</h3>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Primary Focus</label>
                        <select value={target} onChange={e => setTarget(e.target.value)} className={styles.select}>
                            <option value="">Select a goal...</option>
                            <option value="endurance">Endurance & Stability (Fondos/Centuries)</option>
                            <option value="climbing">Climbing & Sustained Power (Threshold)</option>
                            <option value="speed">Speed, Crits & Punchiness (VO2 Max)</option>
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Training Approach</label>
                        <select value={trainingApproach} onChange={e => setTrainingApproach(e.target.value)} className={styles.select}>
                            <option value="suggested">Suggested from history</option>
                            <option value="conservative">Conservative</option>
                            <option value="moderate">Moderate</option>
                            <option value="balanced">Balanced</option>
                            <option value="aggressive">Aggressive</option>
                            <option value="very_aggressive">Very aggressive</option>
                        </select>
                        {recommendation?.suggestedApproach && (
                            <p className="text-sm text-muted" style={{ marginTop: '0.4rem' }}>
                                Suggested: <strong>{recommendation.suggestedApproach.label}</strong> ({recommendation.suggestedApproach.confidence}% confidence)
                            </p>
                        )}
                    </div>

                    <div className={styles.formGroup}>
                        <label>Rest Week Cadence</label>
                        <select value={restWeekCadence} onChange={e => setRestWeekCadence(Number(e.target.value))} className={styles.select}>
                            <option value={2}>Every 2 weeks</option>
                            <option value={3}>Every 3 weeks</option>
                            <option value={4}>Every 4 weeks</option>
                        </select>
                        <p className="text-sm text-muted" style={{ marginTop: '0.4rem' }}>
                            Recovery weeks are scheduled automatically based on this cadence.
                        </p>
                    </div>

                    <div className={styles.formGroup} style={{ marginTop: '-0.2rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={autoSyncCalendar}
                                onChange={(e) => setAutoSyncCalendar(e.target.checked)}
                            />
                            Auto-update calendar weeks 3-8 on new data
                        </label>
                    </div>

                    <div className={styles.formGroup} style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.8rem' }}>
                        <label>Planning Constraints / Events</label>
                        <div style={{ display: 'grid', gap: '0.5rem' }}>
                            <input
                                placeholder="Title (optional)"
                                value={newConstraint.title}
                                onChange={e => setNewConstraint(prev => ({ ...prev, title: e.target.value }))}
                                className={styles.select}
                            />
                            <select value={newConstraint.type} onChange={e => setNewConstraint(prev => ({ ...prev, type: e.target.value }))} className={styles.select}>
                                <option value="race">Race</option>
                                <option value="taper">Taper</option>
                                <option value="travel">Travel</option>
                                <option value="holiday">Holiday</option>
                                <option value="illness">Sickness</option>
                                <option value="unavailable">Unavailable</option>
                                <option value="custom">Custom</option>
                            </select>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                                <input type="date" value={newConstraint.startDate} onChange={e => setNewConstraint(prev => ({ ...prev, startDate: e.target.value }))} className={styles.select} />
                                <input type="date" value={newConstraint.endDate} onChange={e => setNewConstraint(prev => ({ ...prev, endDate: e.target.value }))} className={styles.select} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                                <select value={newConstraint.precedence} onChange={e => setNewConstraint(prev => ({ ...prev, precedence: e.target.value }))} className={styles.select}>
                                    <option value="hard">Block training (hard)</option>
                                    <option value="soft">Reduce load (soft)</option>
                                </select>
                                <input
                                    type="number"
                                    min="0"
                                    max="80"
                                    step="5"
                                    value={Math.round((Number(newConstraint.reduceAvailability || 0)) * 100)}
                                    onChange={e => setNewConstraint(prev => ({ ...prev, reduceAvailability: Math.max(0, Math.min(0.8, Number(e.target.value || 0) / 100)) }))}
                                    className={styles.select}
                                    title="Load reduction % for soft constraints"
                                />
                            </div>
                            <p className="text-sm text-muted" style={{ marginTop: '0.1rem' }}>
                                Block training removes planned workouts on matching dates. Reduce load keeps workouts but scales volume and intensity down.
                            </p>
                            <button type="button" onClick={addConstraint} className={styles.generateBtn} style={{ width: 'auto', padding: '0.55rem 0.8rem' }}>
                                Add Constraint
                            </button>

                            {constraints.length > 0 && (
                                <div style={{ marginTop: '0.4rem', display: 'grid', gap: '0.35rem' }}>
                                    {constraints
                                        .slice()
                                        .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
                                        .map((constraint) => (
                                            <div key={constraint.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--bg-secondary)' }}>
                                                <span style={{ fontSize: '0.8rem' }}>
                                                    {constraint.title || constraint.type} ({constraint.startDate} to {constraint.endDate}) [{constraint.precedence || getConstraintPrecedence(constraint)}]
                                                </span>
                                                <button type="button" onClick={() => removeConstraint(constraint.id)} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                                    Remove
                                                </button>
                                            </div>
                                        ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Weekly Availability (Hours)</label>
                        <input
                            type="range" min="3" max="15" step="1"
                            value={availHours} onChange={e => setAvailHours(Number(e.target.value))}
                            className={styles.range}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <span>3h</span>
                            <span style={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}>{availHours} hrs</span>
                            <span>15h+</span>
                        </div>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Training Days per Week</label>
                        <input
                            type="range" min="2" max="7" step="1"
                            value={daysAvailable} onChange={e => setDaysAvailable(Number(e.target.value))}
                            className={styles.range}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <span>2 days</span>
                            <span style={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}>{daysAvailable} days</span>
                            <span>7 days</span>
                        </div>
                    </div>

                    <button
                        onClick={generateAndSavePlan}
                        disabled={!target}
                        className={styles.generateBtn}
                    >
                            {recommendation ? 'Regenerate Plan' : 'Generate Recommendations'} <ArrowRight size={16} />
                    </button>
                </div>

                {/* 3. Recommendation Engine */}
                {recommendation && (
                    <div className={styles.recCard}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                                <h2 className={styles.recTitle} style={{ margin: 0 }}>{recommendation.title}</h2>
                                {lastSavedPlan.current?.generatedAt && (
                                    <span style={{
                                        fontSize: '0.72rem',
                                        color: 'var(--text-secondary)',
                                        background: 'var(--bg-secondary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: '12px',
                                        padding: '0.2rem 0.6rem',
                                    }}>
                                        Auto-generated {new Date(lastSavedPlan.current.generatedAt).toLocaleDateString()}
                                    </span>
                                )}
                            </div>

                        <div className={styles.recBody}>
                            <div className={styles.recText}>
                                <div className={styles.recDesc}>
                                    {recommendation.description.split('\n\n').map((para, i) => (
                                        <p key={i} dangerouslySetInnerHTML={{
                                            __html: para.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                                                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                                        }} style={{ marginBottom: '1rem' }} />
                                    ))}
                                </div>

                                {/* Weekly Session Plan */}
                                {recommendation.weeklyPlan && (
                                    <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
                                        <h4 style={{ marginBottom: '1rem', fontSize: '0.95rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Weekly Training Breakdown</h4>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                                            {recommendation.weeklyPlan.sessions.map((session, i) => (
                                                <div key={i} style={{
                                                    padding: '1rem',
                                                    background: 'var(--bg-secondary)',
                                                    borderRadius: '8px',
                                                    border: '1px solid var(--border-color)'
                                                }}>
                                                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                                        {session.type}
                                                    </div>
                                                    <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                                                        {session.count}x
                                                    </div>
                                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                        {formatHoursToHrMin(session.hoursPerSession)} each
                                                    </div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: 500 }}>
                                                        {formatHoursToHrMin(session.totalWeekly)} total
                                                        </div>
                                                        {session.intervalDetails && (
                                                            <div style={{
                                                                marginTop: '0.6rem',
                                                                padding: '0.45rem 0.5rem',
                                                                background: 'var(--bg-primary)',
                                                                borderRadius: '4px',
                                                                borderLeft: '3px solid var(--accent-primary)',
                                                            }}>
                                                                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                                                                    {session.intervalDetails.label}
                                                                </div>
                                                                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                                                                    {session.intervalDetails.restLabel}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                            ))}
                                        </div>
                                        <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.9rem' }}>
                                            <strong>Total Weekly:</strong> {formatHoursToHrMin(recommendation.weeklyPlan.totalWeeklyHours)} across {recommendation.weeklyPlan.sessionsPerWeek} sessions
                                        </div>
                                    </div>
                                )}

                                {/* 4-Week Progressive Plan */}
                                {recommendation.fourWeekPlan && (
                                    <div style={{ marginTop: '2.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
                                        <div style={{ marginBottom: '1.5rem' }}>
                                            <h4 style={{ marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>8-Week Adaptive Block</h4>
                                            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0 }}>
                                                <strong>Strategy:</strong> {recommendation.fourWeekPlan.progressionType} Progression
                                            </p>
                                            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.5rem 0 0 0' }}>
                                                {recommendation.fourWeekPlan.rationale}
                                            </p>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
                                            {recommendation.fourWeekPlan.weeks.map((week, i) => (
                                                (() => {
                                                    const weekConstraints = Array.from((weeklyConstraintMap.get(Number(week.weekNumber || 0)) || new Map()).values());
                                                    return (
                                                <div key={i} style={{
                                                    padding: '1.25rem',
                                                    background: 'var(--bg-secondary)',
                                                    borderRadius: '8px',
                                                    border: `2px solid ${week.weekNumber === 3 ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                                    position: 'relative'
                                                }}>
                                                    {/* Peak week indicator */}
                                                    {week.weekNumber === 3 && (
                                                        <div style={{
                                                            position: 'absolute',
                                                            top: '-10px',
                                                            right: '10px',
                                                            background: 'var(--accent-primary)',
                                                            color: 'white',
                                                            fontSize: '0.7rem',
                                                            padding: '0.3rem 0.6rem',
                                                            borderRadius: '12px',
                                                            fontWeight: 'bold',
                                                            textTransform: 'uppercase'
                                                        }}>
                                                            Key Week
                                                        </div>
                                                    )}

                                                    <div style={{ marginBottom: '0.75rem' }}>
                                                        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                                            Week {week.weekNumber}
                                                        </div>
                                                        <div style={{ fontSize: '1rem', fontWeight: 'bold', color: 'var(--accent-primary)' }}>
                                                            {week.focus}
                                                        </div>
                                                    </div>

                                                    {weekConstraints.length > 0 && (
                                                        <div style={{ marginBottom: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.65rem' }}>
                                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
                                                                Constraints This Week
                                                            </div>
                                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                                                                {weekConstraints.map((constraint, constraintIndex) => {
                                                                    const precedence = getConstraintPrecedence(constraint);
                                                                    const isHard = precedence === 'hard';
                                                                    return (
                                                                        <span
                                                                            key={constraint.id ?? `${week.weekNumber}-${constraintIndex}`}
                                                                            title={`${getConstraintDisplayLabel(constraint)} (${precedence})`}
                                                                            style={{
                                                                                fontSize: '0.66rem',
                                                                                lineHeight: 1.2,
                                                                                padding: '0.18rem 0.4rem',
                                                                                borderRadius: '999px',
                                                                                border: `1px solid ${isHard ? 'rgba(239, 68, 68, 0.7)' : 'rgba(59, 130, 246, 0.7)'}`,
                                                                                background: isHard ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                                                                color: isHard ? '#fecaca' : '#bfdbfe',
                                                                            }}
                                                                        >
                                                                            {isHard ? 'Block' : 'Reduce'}: {getConstraintDisplayLabel(constraint)}
                                                                        </span>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Session breakdown for this week */}
                                                    <div style={{ marginBottom: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                                                        {week.sessions.map((session, j) => (
                                                            <div key={j}>
                                                                <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                                                                    <span style={{ color: 'var(--text-secondary)' }}>{session.count}x {session.type}</span>
                                                                    <span style={{ fontWeight: 500, marginLeft: '0.25rem' }}>
                                                                        {formatHoursToHrMin(session.hoursPerSession)} each
                                                                    </span>
                                                                    <span style={{ color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>
                                                                        ({formatHoursToHrMin(session.totalWeekly)} total)
                                                                    </span>
                                                                </div>
                                                                {session.intervalDetails && (
                                                                    <div style={{
                                                                        marginBottom: '0.5rem',
                                                                        marginLeft: '0.75rem',
                                                                        padding: '0.35rem 0.5rem',
                                                                        background: 'var(--bg-primary)',
                                                                        borderRadius: '4px',
                                                                        borderLeft: '2px solid var(--accent-primary)',
                                                                        fontSize: '0.72rem',
                                                                    }}>
                                                                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                                                            {session.intervalDetails.label}
                                                                        </div>
                                                                        <div style={{ color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                                                                            {session.intervalDetails.restLabel}
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>

                                                    {/* Total hours */}
                                                    <div style={{
                                                        padding: '0.75rem',
                                                        background: 'var(--bg-primary)',
                                                        borderRadius: '6px',
                                                        textAlign: 'center',
                                                        borderTop: '1px solid var(--border-color)',
                                                        paddingTop: '0.75rem'
                                                    }}>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                                            Total Hours
                                                        </div>
                                                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--accent-primary)' }}>
                                                            {formatHoursToHrMin(week.totalWeeklyHours)}
                                                        </div>
                                                    </div>
                                                </div>
                                                    );
                                                })()
                                            ))}
                                        </div>

                                        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.9rem' }}>
                                            <strong>8-Week Total:</strong> {formatHoursToHrMin(recommendation.fourWeekPlan.totalPlanHours)}
                                        </div>

                                        {dayByDayPlan.length > 0 && (
                                            <div style={{ marginTop: '1.5rem' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                                    <h5 style={{ margin: 0, fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Day-by-Day Plan</h5>
                                                    <button
                                                        onClick={publishPlanToCalendar}
                                                        disabled={isPublishingPlan}
                                                        className={styles.generateBtn}
                                                        style={{ width: 'auto', padding: '0.6rem 1rem' }}
                                                    >
                                                        {isPublishingPlan ? 'Adding...' : 'Add 8 Weeks to Calendar'}
                                                    </button>
                                                </div>

                                                {publishStatus && (
                                                    <div style={{ marginTop: '0.65rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                                        {publishStatus}
                                                    </div>
                                                )}

                                                <div style={{ marginTop: '0.85rem', display: 'grid', gap: '0.5rem' }}>
                                                    {dayByDayPlan.map((day, idx) => {
                                                        const matchedConstraints = dayConstraintMatches[idx] || [];
                                                        return (
                                                        <div key={idx} style={{
                                                            display: 'grid',
                                                            gridTemplateColumns: '100px 90px 1fr',
                                                            gap: '0.75rem',
                                                            alignItems: 'center',
                                                            padding: '0.65rem 0.75rem',
                                                            border: `1px solid ${matchedConstraints.length ? 'rgba(59, 130, 246, 0.5)' : 'var(--border-color)'}`,
                                                            borderRadius: '6px',
                                                            background: 'var(--bg-secondary)'
                                                        }}>
                                                            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                                                Week {day.weekNumber}
                                                            </div>
                                                            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                                                                {format(day.date, 'MMM d')} {day.dayLabel}
                                                            </div>
                                                            <div style={{ fontSize: '0.84rem' }}>
                                                                {day.isRest ? 'Rest Day' : `${day.workout.type} - ${Math.round(day.workout.durationSec / 60)}min${day.workout.intervalDetails ? ` - ${day.workout.intervalDetails.label}` : ''}`}

                                                                {matchedConstraints.length > 0 && (
                                                                    <div style={{ marginTop: '0.35rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                                                                        {matchedConstraints.map((constraint, constraintIndex) => {
                                                                            const precedence = getConstraintPrecedence(constraint);
                                                                            const isHard = precedence === 'hard';
                                                                            return (
                                                                                <span
                                                                                    key={constraint.id ?? `${idx}-${constraintIndex}`}
                                                                                    title={`${getConstraintDisplayLabel(constraint)} (${precedence})`}
                                                                                    style={{
                                                                                        fontSize: '0.66rem',
                                                                                        lineHeight: 1.2,
                                                                                        padding: '0.16rem 0.4rem',
                                                                                        borderRadius: '999px',
                                                                                        border: `1px solid ${isHard ? 'rgba(239, 68, 68, 0.7)' : 'rgba(59, 130, 246, 0.7)'}`,
                                                                                        background: isHard ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                                                                        color: isHard ? '#fecaca' : '#bfdbfe',
                                                                                    }}
                                                                                >
                                                                                    {isHard ? 'Block' : 'Reduce'}: {getConstraintDisplayLabel(constraint)}
                                                                                </span>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className={styles.recChart}>
                                <h4>Recommended Distribution</h4>
                                <ResponsiveContainer width="100%" height={200}>
                                    <PieChart>
                                        <Pie
                                            data={recommendation.focusZones}
                                            dataKey="value"
                                            nameKey="name"
                                            cx="50%" cy="50%"
                                            innerRadius={40}
                                            outerRadius={70}
                                        >
                                            {recommendation.focusZones.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Pie>
                                        <Tooltip />
                                        <Legend />
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default FutureTraining;
