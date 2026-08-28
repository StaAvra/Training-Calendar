import React, { useState, useEffect, useMemo } from 'react';
import { Clock, Navigation, Zap, Activity, Heart, TrendingUp, Save, Trash2, Edit2, X, ZoomOut } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceArea } from 'recharts';
import { calculateIntensityFactor, calculateTimeInZones, calculateTSS, calculateNormalizedPower, identifyImprovements, classifyWorkout, getEffectiveFtp } from '../utils/analysis';
import { useUser } from '../context/UserContext';
import { db, getLocalDayKey } from '../utils/db';
import styles from './RideDetailsModal.module.css';

const RideDetailsModal = ({ workout, onClose }) => {
    const { currentUser } = useUser();

    const emitRefresh = () => {
        if (typeof window === 'undefined' || !currentUser) return;
        window.dispatchEvent(new CustomEvent('training-data-updated', {
            detail: { entity: 'workout', action: 'refresh', userId: currentUser.id }
        }));
    };

    // Edit State
    const [isEditing, setIsEditing] = useState(false);
    const [editFormData, setEditFormData] = useState({});

    // Feedback State
    const [rpe, setRpe] = useState(5);
    const [feeling, setFeeling] = useState(5);
    const [notes, setNotes] = useState('');
    const [completionStatus, setCompletionStatus] = useState('planned');
    const [successScorePreview, setSuccessScorePreview] = useState(null);
    const [plannedRideCandidates, setPlannedRideCandidates] = useState([]);
    const [plannedDateFilter, setPlannedDateFilter] = useState('');
    const [selectedPlannedRideId, setSelectedPlannedRideId] = useState('');

    const [isSaving, setIsSaving] = useState(false);

    // Zoom State
    const [refAreaLeft, setRefAreaLeft] = useState('');
    const [refAreaRight, setRefAreaRight] = useState('');
    const [zoomedDomain, setZoomedDomain] = useState(null); // [start, end] derived from 'time' key

    useEffect(() => {
        if (workout) {
            setRpe(workout.rpe || 5);
            setFeeling(workout.feeling_strength || 5);
            setNotes(workout.notes || '');
            setCompletionStatus(workout.completion_status || (workout.completed ? 'completed' : (workout.planned ? 'planned' : 'completed')));

            // Init form data
            setEditFormData({
                title: workout.title,
                date: new Date(workout.date).toISOString().slice(0, 10),
                duration: (workout.total_elapsed_time / 60).toFixed(0), // mins for edit
                distance: ((workout.total_distance || 0) / 1000).toFixed(1),
                avg_power: Math.round(workout.avg_power || 0),
                normalized_power: Math.round(workout.normalized_power || workout.avg_power || 0),
                tss: Math.round(calculateTSS(workout, currentUser?.profile?.ftp || 250) || 0),
                structured_reps: workout.structured_reps ?? '',
                structured_interval_mins: workout.structured_interval_mins ?? '',
                structured_rest_mins: workout.structured_rest_mins ?? '',
                structured_power_low: workout.structured_power_low ?? ''
            });
            setZoomedDomain(null);

            const incomingDay = getLocalDayKey(workout.date || workout.start_time);
            setPlannedDateFilter(incomingDay || getLocalDayKey(new Date()) || '');
            setSelectedPlannedRideId('');
        }
    }, [workout, currentUser]);

    useEffect(() => {
        const loadPlannedRideCandidates = async () => {
            if (!currentUser || !workout) {
                setPlannedRideCandidates([]);
                return;
            }

            const all = await db.getWorkouts(currentUser.id);
            const candidates = all
                .filter(w => {
                    if (!w || w.id === workout.id) return false;
                    const status = w.completion_status || (w.completed ? 'completed' : (w.planned ? 'planned' : 'completed'));
                    const isPlanned = w.planned === true || w.plan_source === 'four_week' || status === 'planned';
                    return isPlanned && status !== 'completed';
                })
                .sort((a, b) => new Date(a.date || a.start_time) - new Date(b.date || b.start_time));

            setPlannedRideCandidates(candidates);
        };

        loadPlannedRideCandidates();
    }, [currentUser, workout]);

    // Zoom Handlers
    const zoom = () => {
        if (refAreaLeft === refAreaRight || refAreaRight === '') {
            setRefAreaLeft('');
            setRefAreaRight('');
            return;
        }

        // Correct order if user dragged right-to-left
        let [left, right] = [refAreaLeft, refAreaRight];
        if (left > right) [left, right] = [right, left];

        setZoomedDomain([left, right]);
        setRefAreaLeft('');
        setRefAreaRight('');
    };

    const zoomOut = () => {
        setZoomedDomain(null);
    };

    if (!workout) return null;

    // Constants for Display
    // Priority: Imported -> Workout -> Test -> CP (via getEffectiveFtp)
    // We pass currentProfileFtp as fallback (Priority 3)
    const ftp = getEffectiveFtp(workout, currentUser?.profile?.ftp);

    // Dynamic Metrics Calculation Check
    let currentMetrics = {
        duration: workout.total_elapsed_time,
        distance: workout.total_distance || 0,
        avg_power: workout.avg_power || 0,
        normalized_power: workout.normalized_power || workout.avg_power || 0,
        avg_heart_rate: workout.avg_heart_rate || 0,
        tss: calculateTSS(workout, ftp),
        kj: ((workout.avg_power || 0) * workout.total_elapsed_time) / 1000
    };

    // If Editing, override with form data (approximate for now as we don't recalc NP on edit easily without stream)
    if (isEditing) {
        currentMetrics = {
            duration: Number(editFormData.duration) * 60,
            distance: Number(editFormData.distance) * 1000,
            avg_power: Number(editFormData.avg_power),
            normalized_power: Number(editFormData.normalized_power),
            avg_heart_rate: workout.avg_heart_rate || 0, // Not editable
            tss: Number(editFormData.tss),
            kj: (Number(editFormData.avg_power) * Number(editFormData.duration) * 60) / 1000
        };
    }

    // If Zoomed, calculate metrics from slice
    if (zoomedDomain && workout.streams) {
        const [start, end] = zoomedDomain;
        const slice = workout.streams.filter(d => d.time >= start && d.time <= end);

        if (slice.length > 0) {
            const duration = slice[slice.length - 1].time - slice[0].time;

            // Avg Power
            const sumPower = slice.reduce((acc, curr) => acc + (curr.power || 0), 0);
            const avgPower = Math.round(sumPower / slice.length);

            // Avg HR
            const validHr = slice.filter(d => d.heart_rate);
            const sumHr = validHr.reduce((acc, curr) => acc + curr.heart_rate, 0);
            const avgHr = validHr.length ? Math.round(sumHr / validHr.length) : 0;

            // NP
            const np = calculateNormalizedPower(slice);

            // Distance if available
            let dist = 0;
            if (slice[0].distance !== undefined) {
                dist = slice[slice.length - 1].distance - slice[0].distance;
            }

            // IF / TSS
            const ifVal = np / ftp;
            const tss = slice.length > 0 ? (duration * np * ifVal) / (ftp * 36) : 0;

            currentMetrics = {
                duration: duration,
                distance: dist,
                avg_power: avgPower,
                normalized_power: np,
                avg_heart_rate: avgHr,
                tss: Math.round(tss),
                kj: (avgPower * duration) / 1000
            };
        }
    }

    // Prepare Display Values
    const displayDuration = isEditing ? editFormData.duration + ' m' : (zoomedDomain ? new Date(currentMetrics.duration * 1000).toISOString().substr(11, 8) : new Date(workout.total_elapsed_time * 1000).toISOString().substr(11, 8));
    if (zoomedDomain) {
        // Special formatting for duration when zoomed? 
        // Actually the standard HMS format works well.
    }

    // Convert logic to string
    const dDuration = zoomedDomain
        ? new Date(currentMetrics.duration * 1000).toISOString().substr(11, 8)
        : (isEditing ? editFormData.duration + ' m' : new Date(workout.total_elapsed_time * 1000).toISOString().substr(11, 8));

    const dDist = currentMetrics.distance > 0 ? (currentMetrics.distance / 1000).toFixed(1) : '--';
    // Average speed in km/h
    const dAvgSpeed = currentMetrics.duration > 0 && currentMetrics.distance > 0
        ? (currentMetrics.distance / currentMetrics.duration * 3.6).toFixed(1)
        : '--';
    const dAvgPwr = Math.round(currentMetrics.avg_power);
    const dAvgHR = Math.round(currentMetrics.avg_heart_rate);
    const dNP = Math.round(currentMetrics.normalized_power);
    const dIF = (dNP / ftp).toFixed(2);
    const dTSS = Math.round(currentMetrics.tss || 0);
    const dkJ = (currentMetrics.kj || 0).toFixed(0);

    const zones = calculateTimeInZones(workout.streams, ftp);
    const maxZoneTime = Math.max(...zones.map(z => z.time || 0), 1);

    // Re-calculating improvements for this specific ride relative to ALL historical data
    const [rideImprovements, setRideImprovements] = useState([]);
    useEffect(() => {
        const checkPRs = async () => {
            if (!workout || !currentUser) return;
            const allWorkouts = await db.getWorkouts(currentUser.id);
            // Sort by date so we check progression
            const sorted = allWorkouts.sort((a, b) => new Date(a.date) - new Date(b.date));
            const impMap = identifyImprovements(sorted);
            setRideImprovements(impMap[workout.id] || []);
        };
        checkPRs();
    }, [workout, currentUser]);

    const plannedDateOptions = useMemo(() => {
        const uniqueDays = Array.from(new Set(plannedRideCandidates
            .map(w => getLocalDayKey(w.date || w.start_time))
            .filter(Boolean)
        ));
        return uniqueDays.sort((a, b) => new Date(a) - new Date(b));
    }, [plannedRideCandidates]);

    const filteredPlannedRides = useMemo(() => {
        if (!plannedDateFilter) return plannedRideCandidates;
        return plannedRideCandidates.filter(w => getLocalDayKey(w.date || w.start_time) === plannedDateFilter);
    }, [plannedRideCandidates, plannedDateFilter]);

    // ... logic for handlers ... reference below code

    const handleEditChange = (e) => {
        const { name, value } = e.target;
        setEditFormData(prev => ({
            ...prev,
            [name]: value
        }));
    };

    const getPlannedExpectedTss = (durationSec, targetAvgPower, ftpValue) => {
        if (!durationSec || !targetAvgPower || !ftpValue) return null;
        const ifVal = targetAvgPower / ftpValue;
        return (durationSec * targetAvgPower * ifVal) / (ftpValue * 36);
    };

    const getIntervalPenalty = (workoutData) => {
        const reps = Number(workoutData.structured_reps || 0);
        const intervalMins = Number(workoutData.structured_interval_mins || 0);
        const restMins = Number(workoutData.structured_rest_mins || 0);
        const targetLow = Number(workoutData.structured_power_low || 0);
        if (!reps || !intervalMins || !targetLow) return 0;

        let totalPenalty = 0;
        const intervalSec = intervalMins * 60;
        const cycleSec = (intervalMins + restMins) * 60;
        const warmupSec = 10 * 60;

        if (Array.isArray(workoutData.streams) && workoutData.streams.length > 0) {
            for (let i = 0; i < reps; i++) {
                const start = warmupSec + (i * cycleSec);
                const end = start + intervalSec;
                const samples = workoutData.streams.filter(p => p.time >= start && p.time < end && typeof p.power === 'number');
                const avg = samples.length ? (samples.reduce((acc, p) => acc + p.power, 0) / samples.length) : 0;
                const wattsUnder = Math.max(0, targetLow - avg);
                totalPenalty += wattsUnder * 2;
            }
            return totalPenalty;
        }

        // Fallback when stream data is unavailable: use average power as interval proxy.
        const proxyAvg = Number(workoutData.avg_power || 0);
        const wattsUnder = Math.max(0, targetLow - proxyAvg);
        return reps * wattsUnder * 2;
    };

    const computeExecutionScore = (workoutData, ftpValue) => {
        const actualTss = Number(calculateTSS(workoutData, ftpValue) || 0);
        const expectedTss = Number(
            workoutData.expected_tss ||
            getPlannedExpectedTss(
                workoutData.total_elapsed_time,
                workoutData.structured_target_avg || workoutData.avg_power,
                ftpValue
            ) ||
            0
        );

        let score = 100;
        if (expectedTss > 0) {
            const tssThreshold = expectedTss * 0.9;
            if (actualTss < tssThreshold) {
                // 1% score reduction for each TSS point below 90% of expected TSS.
                score -= (tssThreshold - actualTss);
            }
        }

        score -= getIntervalPenalty(workoutData);
        const finalScore = Math.max(0, Math.round(score * 10) / 10);
        return {
            score: finalScore,
            expectedTss: Math.round(expectedTss * 10) / 10,
            actualTss: Math.round(actualTss * 10) / 10,
            success: finalScore >= 90,
        };
    };

    const handleSave = async () => {
        setIsSaving(true);

        const previousCompletion = workout.completion_status || (workout.completed ? 'completed' : (workout.planned ? 'planned' : 'completed'));
        const nextCompletion = completionStatus;
        const isCompleted = nextCompletion === 'completed';

        const updates = {
            rpe: Number(rpe),
            feeling_strength: Number(feeling),
            notes,
            completion_status: nextCompletion,
            completed: isCompleted,
        };

        if (isEditing) {
            updates.title = editFormData.title;
            if (editFormData.date) {
                const originalDate = new Date(workout.date);
                const nextDate = new Date(`${editFormData.date}T00:00:00`);
                nextDate.setHours(originalDate.getHours(), originalDate.getMinutes(), originalDate.getSeconds(), originalDate.getMilliseconds());
                updates.date = nextDate.toISOString();
            }
            updates.total_elapsed_time = Number(editFormData.duration) * 60;
            // Keep moving_time aligned with manual duration edits so TSS reflects edited stats.
            updates.moving_time = updates.total_elapsed_time;
            updates.total_distance = Number(editFormData.distance) * 1000;
            updates.avg_power = Number(editFormData.avg_power);
            updates.normalized_power = Number(editFormData.normalized_power);

            if (workout.planned_interval_zone) {
                const nextLow = Number(editFormData.structured_power_low);
                const nextHigh = Number.isFinite(nextLow) ? nextLow + 10 : null;
                updates.structured_reps = Number(editFormData.structured_reps) || null;
                updates.structured_interval_mins = Number(editFormData.structured_interval_mins) || null;
                updates.structured_rest_mins = Number(editFormData.structured_rest_mins) || null;
                updates.structured_power_low = Number.isFinite(nextLow) ? nextLow : null;
                updates.structured_power_high = Number.isFinite(nextLow) ? nextHigh : null;
                updates.structured_target_avg = Number.isFinite(nextLow) ? Math.round((nextLow + nextHigh) / 2) : null;
            }
        }

        // Planned rides can be marked complete with feedback only.
        // If no manual metric edit is done, keep or derive planned metrics automatically.
        if (isCompleted && !isEditing && workout.plan_source === 'four_week') {
            updates.total_elapsed_time = workout.total_elapsed_time || updates.total_elapsed_time;
            const targetAvg = workout.structured_target_avg || workout.avg_power || null;
            if (targetAvg) {
                updates.avg_power = workout.avg_power || targetAvg;
                updates.normalized_power = workout.normalized_power || targetAvg;
            }
        }

        const updatedWorkoutForScoring = {
            ...workout,
            ...updates,
            total_elapsed_time: updates.total_elapsed_time ?? workout.total_elapsed_time,
            moving_time: updates.moving_time ?? workout.moving_time,
            avg_power: updates.avg_power ?? workout.avg_power,
            structured_reps: updates.structured_reps ?? workout.structured_reps,
            structured_interval_mins: updates.structured_interval_mins ?? workout.structured_interval_mins,
            structured_rest_mins: updates.structured_rest_mins ?? workout.structured_rest_mins,
            structured_power_low: updates.structured_power_low ?? workout.structured_power_low,
            structured_target_avg: updates.structured_target_avg ?? workout.structured_target_avg,
            expected_tss: workout.expected_tss,
        };

        if (isCompleted) {
            const scoreResult = computeExecutionScore(updatedWorkoutForScoring, ftp);
            updates.success_score = scoreResult.score;
            updates.execution_success = scoreResult.success;
            updates.actual_tss = scoreResult.actualTss;
            updates.expected_tss = scoreResult.expectedTss || workout.expected_tss || null;
            setSuccessScorePreview(scoreResult.score);
        } else {
            updates.success_score = null;
            updates.execution_success = false;
        }

        const manualLinkedRideId = Number(selectedPlannedRideId);
        const canManualLink = isCompleted
            && Number.isFinite(manualLinkedRideId)
            && manualLinkedRideId > 0
            && manualLinkedRideId !== workout.id;

        if (canManualLink && currentUser) {
            const all = await db.getWorkouts(currentUser.id);
            const plannedTarget = all.find(w => w.id === manualLinkedRideId);

            if (plannedTarget) {
                const linkedDate = plannedTarget.date || plannedTarget.start_time || workout.date;
                await db.updateWorkout(plannedTarget.id, {
                    title: workout.title,
                    date: linkedDate,
                    source: workout.source,
                    imported_at: workout.imported_at || new Date().toISOString(),
                    start_time: workout.start_time || workout.date,
                    total_elapsed_time: updates.total_elapsed_time ?? workout.total_elapsed_time,
                    total_distance: updates.total_distance ?? workout.total_distance,
                    avg_speed: workout.avg_speed,
                    avg_power: updates.avg_power ?? workout.avg_power,
                    max_power: workout.max_power,
                    avg_heart_rate: workout.avg_heart_rate,
                    max_heart_rate: workout.max_heart_rate,
                    normalized_power: updates.normalized_power ?? workout.normalized_power,
                    total_work: workout.total_work,
                    calories: workout.calories,
                    elevation_gain: workout.elevation_gain,
                    streams: workout.streams,
                    power_curve: workout.power_curve,
                    heart_rate_curve: workout.heart_rate_curve,
                    rpe: updates.rpe,
                    feeling_strength: updates.feeling_strength,
                    notes: updates.notes,
                    success_score: updates.success_score,
                    execution_success: updates.execution_success,
                    actual_tss: updates.actual_tss,
                    expected_tss: updates.expected_tss,
                    completion_status: 'completed',
                    completed: true,
                    planned: true,
                    linked_actual_workout_id: workout.id,
                });

                await db.deleteWorkout(workout.id);
                emitRefresh();
                setIsSaving(false);
                setIsEditing(false);
                if (onClose) onClose();
                return;
            }
        }

        await db.updateWorkout(workout.id, updates);

        const didJustComplete = previousCompletion !== 'completed' && nextCompletion === 'completed';
        const executionSuccess = updates.execution_success === true;
        if (didJustComplete && executionSuccess && workout.planned_interval_zone && currentUser) {
            const all = await db.getWorkouts(currentUser.id);
            const currentDate = new Date(updates.date || workout.date);
            const futureStructured = all.filter(w =>
                w.id !== workout.id &&
                w.plan_source === 'four_week' &&
                w.planned_interval_zone === workout.planned_interval_zone &&
                (w.completion_status || 'planned') === 'planned' &&
                new Date(w.date) > currentDate &&
                typeof w.structured_power_low === 'number'
            );

            for (const target of futureStructured) {
                const nextLow = target.structured_power_low + 3;
                const nextHigh = nextLow + 10;
                await db.updateWorkout(target.id, {
                    structured_power_low: nextLow,
                    structured_power_high: nextHigh,
                    structured_target_avg: Math.round((nextLow + nextHigh) / 2),
                });
            }
        }

        emitRefresh();
        setIsSaving(false);
        setIsEditing(false);
        if (onClose) onClose();
    };

    const handleDelete = async () => {
        if (confirm('Are you sure you want to delete this ride? This cannot be undone.')) {
            await db.deleteWorkout(workout.id);
            emitRefresh();
            if (onClose) onClose();
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                {isEditing ? (
                    <input
                        className={styles.titleInput}
                        name="title"
                        value={editFormData.title}
                        onChange={handleEditChange}
                    />
                ) : (
                    <h2 className={styles.title}>{workout.title}</h2>
                )}

                <div className={styles.actions}>
                    <div className={styles.classificationBadge} style={{
                        marginRight: 'auto',
                        padding: '4px 10px',
                        borderRadius: '12px',
                        fontSize: '0.8rem',
                        fontWeight: '600',
                        backgroundColor: 'var(--bg-tertiary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                    }}>
                        <Activity size={14} /> {classifyWorkout(workout, ftp)}
                    </div>

                    {rideImprovements.length > 0 && (
                        <div className={styles.prList}>
                            {rideImprovements.map((imp, idx) => (
                                <span key={idx} className={styles.prBadge} title={`Previous best: ${imp.value - (imp.delta || 0)}W`}>
                                    ⭐ {imp.label} {imp.delta ? `(+${imp.delta}W)` : 'PR!'}
                                </span>
                            ))}
                        </div>
                    )}
                    {!isEditing && (
                        <>
                            <button onClick={() => setIsEditing(true)} className={styles.iconBtn} title="Edit Metrics">
                                <Edit2 size={18} />
                            </button>
                            <button onClick={handleDelete} className={styles.iconBtn} style={{ color: 'var(--accent-danger)' }} title="Delete Ride">
                                <Trash2 size={18} />
                            </button>
                        </>
                    )}
                </div>
            </div>

            <div className={styles.grid}>

                <div className={styles.statBox}>
                    <Clock size={20} className={styles.icon} />
                    <div>
                        {isEditing ? (
                            <input name="duration" type="number" value={editFormData.duration} onChange={handleEditChange} className={styles.valInput} />
                        ) : (
                            <span className={styles.value}>{dDuration}</span>
                        )}
                        <span className={styles.label}>Duration {isEditing && '(min)'}</span>
                    </div>
                </div>


                <div className={styles.statBox}>
                    <Navigation size={20} className={styles.icon} />
                    <div>
                        {isEditing ? (
                            <input name="distance" type="number" step="0.1" value={editFormData.distance} onChange={handleEditChange} className={styles.valInput} />
                        ) : (
                            <span className={styles.value}>{dDist} km</span>
                        )}
                        <span className={styles.label}>Distance</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <TrendingUp size={20} className={styles.icon} color="var(--accent-primary)" />
                    <div>
                        {isEditing ? (
                            <input name="avg_speed" type="number" step="0.1" value={((Number(editFormData.distance) / Number(editFormData.duration)) * 60).toFixed(1)} disabled className={styles.valInput} />
                        ) : (
                            <span className={styles.value}>{dAvgSpeed} km/h</span>
                        )}
                        <span className={styles.label}>Avg Speed</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <Zap size={20} className={styles.icon} />
                    <div>
                        {isEditing ? (
                            <input name="avg_power" type="number" value={editFormData.avg_power} onChange={handleEditChange} className={styles.valInput} />
                        ) : (
                            <span className={styles.value}>{dAvgPwr}W</span>
                        )}
                        <span className={styles.label}>Avg Power</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <Heart size={20} className={styles.icon} color="var(--accent-danger)" />
                    <div>
                        <span className={styles.value}>{dAvgHR > 0 ? dAvgHR : '--'} bpm</span>
                        <span className={styles.label}>Avg HR</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <Zap size={20} className={styles.icon} color="var(--accent-warning)" />
                    <div>
                        {isEditing ? (
                            <input name="normalized_power" type="number" value={editFormData.normalized_power} onChange={handleEditChange} className={styles.valInput} />
                        ) : (
                            <span className={styles.value}>{dNP}W</span>
                        )}
                        <span className={styles.label}>Norm. Power</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <Activity size={20} className={styles.icon} color="var(--accent-secondary)" />
                    <div>
                        <span className={styles.value}>{dTSS}</span>
                        <span className={styles.label}>TSS</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <TrendingUp size={20} className={styles.icon} color="var(--accent-danger)" />
                    <div>
                        <span className={styles.value}>{dIF || '--'}</span>
                        <span className={styles.label}>Intensity (IF)</span>
                    </div>
                </div>

                <div className={styles.statBox}>
                    <Zap size={20} className={styles.icon} color="var(--text-accent)" />
                    <div>
                        <span className={styles.value}>{dkJ}</span>
                        <span className={styles.label}>Energy (kJ)</span>
                    </div>
                </div>
            </div>

            <div className={styles.row}>
                {/* Left: Feedback */}
                <div style={{ flex: 1 }}>
                    <h4 className={styles.sectionTitle}>Feedback</h4>
                    <div className={styles.inputGroup}>
                        <label>Workout Completion</label>
                        <select
                            value={completionStatus}
                            onChange={(e) => setCompletionStatus(e.target.value)}
                            className={styles.textarea}
                            style={{ minHeight: 40, padding: '0 10px' }}
                        >
                            <option value="planned">Not completed yet</option>
                            <option value="completed">Completed</option>
                            <option value="skipped">Skipped</option>
                        </select>
                    </div>

                    {!workout.plan_source && completionStatus === 'completed' && plannedRideCandidates.length > 0 && (
                        <>
                            <div className={styles.inputGroup}>
                                <label>Link to Planned Date</label>
                                <select
                                    value={plannedDateFilter}
                                    onChange={(e) => {
                                        setPlannedDateFilter(e.target.value);
                                        setSelectedPlannedRideId('');
                                    }}
                                    className={styles.textarea}
                                    style={{ minHeight: 40, padding: '0 10px' }}
                                >
                                    {plannedDateOptions.map(day => (
                                        <option key={day} value={day}>{day}</option>
                                    ))}
                                </select>
                            </div>

                            <div className={styles.inputGroup}>
                                <label>Link to Planned Ride</label>
                                <select
                                    value={selectedPlannedRideId}
                                    onChange={(e) => setSelectedPlannedRideId(e.target.value)}
                                    className={styles.textarea}
                                    style={{ minHeight: 40, padding: '0 10px' }}
                                >
                                    <option value="">Do not link</option>
                                    {filteredPlannedRides.map(w => (
                                        <option key={w.id} value={w.id}>
                                            {new Date(w.date || w.start_time).toLocaleDateString()} - {w.title || 'Planned Ride'}
                                        </option>
                                    ))}
                                </select>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                    This replaces the selected planned ride with this completed workout.
                                </div>
                            </div>
                        </>
                    )}

                        {completionStatus === 'completed' && successScorePreview != null && (
                            <div className={styles.inputGroup}>
                                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                    Execution success score: <strong>{successScorePreview}%</strong>
                                </div>
                            </div>
                        )}

                    {isEditing && (
                        <div className={styles.inputGroup}>
                            <label>Date (move this ride in calendar)</label>
                            <input
                                type="date"
                                name="date"
                                value={editFormData.date || ''}
                                onChange={handleEditChange}
                                className={styles.valInput}
                            />
                        </div>
                    )}

                    {isEditing && workout.planned_interval_zone && (
                        <>
                            <div className={styles.inputGroup}>
                                <label>Interval Reps</label>
                                <input
                                    type="number"
                                    name="structured_reps"
                                    min="1"
                                    value={editFormData.structured_reps}
                                    onChange={handleEditChange}
                                    className={styles.valInput}
                                />
                            </div>
                            <div className={styles.inputGroup}>
                                <label>Interval Duration (min)</label>
                                <input
                                    type="number"
                                    step="0.5"
                                    min="0.5"
                                    name="structured_interval_mins"
                                    value={editFormData.structured_interval_mins}
                                    onChange={handleEditChange}
                                    className={styles.valInput}
                                />
                            </div>
                            <div className={styles.inputGroup}>
                                <label>Break Duration (min)</label>
                                <input
                                    type="number"
                                    step="0.5"
                                    min="0.5"
                                    name="structured_rest_mins"
                                    value={editFormData.structured_rest_mins}
                                    onChange={handleEditChange}
                                    className={styles.valInput}
                                />
                            </div>
                            <div className={styles.inputGroup}>
                                <label>Power Target Lower Bound (W)</label>
                                <input
                                    type="number"
                                    min="1"
                                    name="structured_power_low"
                                    value={editFormData.structured_power_low}
                                    onChange={handleEditChange}
                                    className={styles.valInput}
                                />
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                    Target range stays 10W wide: {Number(editFormData.structured_power_low || 0)}-{Number(editFormData.structured_power_low || 0) + 10}W
                                </div>
                            </div>
                        </>
                    )}

                    <div className={styles.inputGroup}>
                        <label>RPE (1-10)</label>
                        <input
                            type="range"
                            min="1" max="10"
                            value={rpe}
                            onChange={(e) => setRpe(e.target.value)}
                            className={styles.range}
                        />
                        <span className={styles.rangeValue}>{rpe}</span>
                    </div>
                    <div className={styles.inputGroup}>
                        <label>Feeling Strength (1-10)</label>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>How strong did you feel during the structured part of this ride</div>
                        <input
                            type="range"
                            min="1" max="10"
                            value={feeling}
                            onChange={(e) => setFeeling(e.target.value)}
                            className={styles.range}
                        />
                        <span className={styles.rangeValue}>{feeling}</span>
                    </div>
                    <div className={styles.inputGroup}>
                        <label>Notes</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            className={styles.textarea}
                            placeholder="How did it feel?"
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button onClick={handleSave} className={styles.saveBtn} disabled={isSaving}>
                            <Save size={16} />
                            {isSaving ? 'Saving...' : 'Save All'}
                        </button>
                        {isEditing && (
                            <button onClick={() => setIsEditing(false)} className={styles.cancelBtn}>
                                Cancel
                            </button>
                        )}
                    </div>
                </div>

                {/* Right: Zones */}
                <div style={{ flex: 1, borderLeft: '1px solid var(--border-color)', paddingLeft: 'var(--space-lg)' }}>
                    <h4 className={styles.sectionTitle}>Time in Zones</h4>
                    <div className={styles.zonesContainer}>
                        {zones.map((z, i) => (
                            <div key={i} className={styles.zoneRow}>
                                <span className={styles.zoneName}>{z.name}</span>
                                <div className={styles.barContainer}>
                                    <div
                                        className={styles.barFill}
                                        style={{
                                            width: `${(z.time / maxZoneTime) * 100}%`,
                                            backgroundColor: z.color
                                        }}
                                    ></div>
                                </div>
                                <span className={styles.zoneTime}>{Math.floor(z.time / 60)}m</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {workout.streams && workout.streams.length > 0 && (
                <div style={{ marginTop: 'var(--space-xl)', height: '300px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <h4 className={styles.sectionTitle}>Power & Heart Rate Analysis</h4>
                        {zoomedDomain && (
                            <button
                                onClick={zoomOut}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '4px',
                                    padding: '4px 8px', fontSize: '12px',
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                    borderRadius: '4px', cursor: 'pointer'
                                }}
                            >
                                <ZoomOut size={14} /> Reset Zoom
                            </button>
                        )}
                    </div>
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                            data={workout.streams}
                            onMouseDown={(e) => setRefAreaLeft(e && e.activeLabel)}
                            onMouseMove={(e) => refAreaLeft && setRefAreaRight(e && e.activeLabel)}
                            onMouseUp={zoom}
                        >
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                            <XAxis
                                dataKey="time"
                                type="number"
                                domain={zoomedDomain ? zoomedDomain : ['dataMin', 'dataMax']}
                                allowDataOverflow={true}
                                tickFormatter={(val) => new Date(val * 1000).toISOString().substr(11, 8)}
                                stroke="var(--text-secondary)"
                                fontSize={12}
                                minTickGap={50}
                            />
                            <YAxis yAxisId="left" stroke="var(--accent-primary)" fontSize={12} label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                            <YAxis yAxisId="right" orientation="right" stroke="var(--accent-danger)" fontSize={12} label={{ value: 'BPM', angle: 90, position: 'insideRight', fill: 'var(--text-secondary)' }} />
                            <Tooltip
                                labelFormatter={(val) => new Date(val * 1000).toISOString().substr(11, 8)}
                                contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                            />
                            <Legend />
                            <Line yAxisId="left" type="monotone" dataKey="power" stroke="var(--accent-primary)" dot={false} strokeWidth={1.5} name="Power (W)" isAnimationActive={false} />
                            <Line yAxisId="right" type="monotone" dataKey="heart_rate" stroke="var(--accent-danger)" dot={false} strokeWidth={1.5} name="Heart Rate (bpm)" connectNulls isAnimationActive={false} />

                            {refAreaLeft && refAreaRight ? (
                                <ReferenceArea yAxisId="left" x1={refAreaLeft} x2={refAreaRight} strokeOpacity={0.3} fill="var(--text-primary)" fillOpacity={0.1} />
                            ) : null}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
};

export default RideDetailsModal;
