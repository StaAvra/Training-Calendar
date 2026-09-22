import { startOfWeek, endOfWeek, addWeeks } from 'date-fns';
import { trainResponderModel, describeResponderProfile } from './intelligence/mlModel.js';

/**
 * Analyzes the correlation between Training Stress (TSS/Volume) and Performance Adaptations.
 * Looks for blocks where performance Metrics (CP/FTP) improved significantly.
 */
export const analyzeAdaptations = (workouts, metrics, ftpHistory) => {
    const now = new Date();
    const completedWorkouts = (workouts || []).filter((workout) => {
        const workoutDate = new Date(workout.date);
        if (Number.isNaN(workoutDate.getTime()) || workoutDate > now) return false;

        const isStillPlanned = (workout.planned === true || workout.completion_status === 'planned')
            && workout.completed !== true
            && workout.completion_status !== 'completed';

        if (isStillPlanned) return false;
        return Number(workout.total_elapsed_time || 0) > 0;
    });

    if (completedWorkouts.length < 20) return { insufficientData: true };

    // 1. Create a Time Series of Weekly Stats (TSS, Volume, Intensity Distribution) vs Performance
    const weeklyStats = [];
    const sortedWorkouts = [...completedWorkouts].sort((a, b) => new Date(a.date) - new Date(b.date));

    if (!sortedWorkouts.length) return { insufficientData: true };

    const firstDate = new Date(sortedWorkouts[0].date);
    const lastDate = new Date(sortedWorkouts[sortedWorkouts.length - 1].date);

    // Calculate TSS fallback using NP and IF if not provided in FIT file
    const enrichedWorkouts = sortedWorkouts.map(w => {
        let tss = w.training_stress_score;

        // Fallback TSS calculation if missing
        if (!tss && w.normalized_power && w.intensity_factor) {
            const durationHours = (w.total_elapsed_time || 0) / 3600;
            tss = (durationHours * w.normalized_power * w.intensity_factor * 100) / (250 * 3600); // Using 250W FTP as generic baseline
        }

        // Fallback based on volume and average power
        if (!tss && w.total_elapsed_time && w.avg_power) {
            const durationHours = w.total_elapsed_time / 3600;
            tss = durationHours * w.avg_power / 10; // Rough heuristic
        }

        return { ...w, calculated_tss: tss || 0 };
    });

    // Iterate week by week
    let currentWeekStart = startOfWeek(firstDate, { weekStartsOn: 1 });

    while (currentWeekStart <= lastDate) {
        const currentWeekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });

        // Filter workouts for this week
        const weeksWorkouts = enrichedWorkouts.filter(w => {
            const d = new Date(w.date);
            return d >= currentWeekStart && d <= currentWeekEnd;
        });

        // specific distribution
        const zoneDist = { recovery: 0, endurance: 0, tempo: 0, threshold: 0, vo2: 0, anaerobic: 0 };
        let totalTime = 0;

        weeksWorkouts.forEach(w => {
            // simplified distribution based on main zone if detailed streams not avail
            // ideally we'd use timeInZones but lets use a heuristic for speed if streams missing
            // or assume w.time_in_zones exists
            totalTime += w.total_elapsed_time;
        });

        const weeklyTss = weeksWorkouts.reduce((acc, w) => acc + (w.training_stress_score || w.calculated_tss || 0), 0);
        const weeklyVol = weeksWorkouts.reduce((acc, w) => acc + (w.total_elapsed_time || 0), 0) / 3600;

        // Find performance markers for this week (e.g. max CP for different durations)
        // We look for "breakthroughs" or high inputs
        const bests = {
            cp1m: 0,
            cp5m: 0,
            cp20m: 0
        };

        weeksWorkouts.forEach(w => {
            if (w.power_curve) {
                if (w.power_curve.duration_1m > bests.cp1m) bests.cp1m = w.power_curve.duration_1m;
                if (w.power_curve.duration_5m > bests.cp5m) bests.cp5m = w.power_curve.duration_5m;
                if (w.power_curve.duration_20m > bests.cp20m) bests.cp20m = w.power_curve.duration_20m;
            }
        });

        weeklyStats.push({
            date: currentWeekStart,
            tss: weeklyTss,
            volume: weeklyVol,
            performance: bests,
            // avg feeling for the week (default 5 if not set)
            feeling: weeksWorkouts.length ? (weeksWorkouts.reduce((acc, w) => acc + (w.feeling_strength || 5), 0) / weeksWorkouts.length) : 5
        });

        currentWeekStart = addWeeks(currentWeekStart, 1);
    }

    // 2. Identify "Success Blocks"
    // A success block is a 4-6 week period where the ENDING performance is significantly higher than the STARTING performance
    // We look at rolling averages
    const adaptations = [];
    const stagnationZones = [];

    for (let i = 4; i < weeklyStats.length; i++) {
        const current = weeklyStats[i];
        const fourWeeksAgo = weeklyStats[i - 4];

        if (!fourWeeksAgo) continue;

        // Check for improvement (lowered threshold to 1.5% to catch real gains in test data)
        const improvements = [];
        // Filter out zero values to avoid false positives
        if (fourWeeksAgo.performance.cp20m > 0 && current.performance.cp20m > fourWeeksAgo.performance.cp20m * 1.015) improvements.push('Threshold (20m)');
        if (fourWeeksAgo.performance.cp5m > 0 && current.performance.cp5m > fourWeeksAgo.performance.cp5m * 1.015) improvements.push('VO2 Max (5m)');
        if (fourWeeksAgo.performance.cp1m > 0 && current.performance.cp1m > fourWeeksAgo.performance.cp1m * 1.015) improvements.push('Anaerobic (1m)');

        // Also check for volume-driven improvements (consistent volume growth)
        const volGrowth = fourWeeksAgo.volume > 0 ? (current.volume - fourWeeksAgo.volume) / fourWeeksAgo.volume : 0;

        // Avg Stress during this block
        const blockStats = weeklyStats.slice(i - 4, i + 1);
        const avgBlockTss = blockStats.reduce((acc, w) => acc + w.tss, 0) / blockStats.length;
        const avgBlockVol = blockStats.reduce((acc, w) => acc + w.volume, 0) / blockStats.length;
        const avgFeeling = blockStats.reduce((acc, w) => acc + (w.feeling || 0), 0) / blockStats.length;

        // Success = improvements OR consistent volume growth with positive feeling
        if (improvements.length > 0 || (volGrowth > 0.05 && avgFeeling > 4)) {
            // Was it a "Recovery Adaptation"? (TSS Decreasing while Perf Increasing)
            const prevBlockTss = weeklyStats.slice(Math.max(0, i - 8), i - 4).reduce((acc, w) => acc + w.tss, 0) / (Math.min(4, Math.max(0, i - 4)));
            const isRecoveryAdaptation = prevBlockTss > (avgBlockTss * 1.2); // 20% drop in stress

            adaptations.push({
                date: current.date,
                type: isRecoveryAdaptation ? 'Recovery Adaptation' : 'Stress Adaptation',
                improvements: improvements.length > 0 ? improvements : ['Consistent Volume Growth'],
                avgTss: avgBlockTss,
                avgVol: avgBlockVol,
                avgFeeling
            });
        }
        // Check for Overtraining / Stagnation
        // High Stress + Low Feeling + No Improvement (or Decline)
        else if (avgBlockTss > 300 && avgFeeling < 6) { // Arbitrary thresholds, should be relative to user history ideally
            // Check for decline
            const isDecline = current.performance.cp20m < fourWeeksAgo.performance.cp20m * 0.98;
            if (isDecline || (avgBlockTss > 450 && avgFeeling < 5)) {
                stagnationZones.push({
                    date: current.date,
                    avgTss: avgBlockTss,
                    avgVol: avgBlockVol,
                    reason: isDecline ? 'Performance Decline despite High Stress' : 'High Stress with Low Feeling',
                    feeling: avgFeeling
                });
            }
        }
    }

    return {
        workouts: enrichedWorkouts,
        weeklyStats,
        adaptations,
        stagnationZones
    };
};

export const analyzeResponderProfile = (analysis, profile) => {
    const model = trainResponderModel(analysis, profile);
    const narrative = describeResponderProfile(model);

    return {
        responderType: model.responderType,
        confidence: model.confidence,
        volumeResponderScore: model.responderProbabilities?.Volume || 0,
        intensityResponderScore: model.responderProbabilities?.Intensity || 0,
        balancedResponderScore: model.responderProbabilities?.Balanced || 0,
        mixedResponderScore: model.responderProbabilities?.Mixed || 0,
        bestHistoricalMix: model.bestHistoricalMix,
        responderTimeline: model.responderTimeline,
        hasResponderShift: model.hasResponderShift,
        lastShiftDate: model.lastShiftDate,
        trainedBlockCount: model.trainedBlockCount,
        modelType: model.modelType,
        featureImportance: model.featureImportance,
        currentState: model.currentState,
        recommendations: narrative
    };
};

const TRAINING_APPROACHES = {
    conservative: {
        key: 'conservative',
        label: 'Conservative',
        volumeRamp: 0.02,
        secondBlockBoost: 0.01,
        recoveryMultiplier: 0.78,
        powerStep: 2,
        powerBiasPct: -0.015,
        weeklyPowerRampPct: 0.002,
        progressionCycle: 4,
    },
    moderate: {
        key: 'moderate',
        label: 'Moderate',
        volumeRamp: 0.04,
        secondBlockBoost: 0.015,
        recoveryMultiplier: 0.76,
        powerStep: 4,
        powerBiasPct: -0.005,
        weeklyPowerRampPct: 0.004,
        progressionCycle: 3,
    },
    balanced: {
        key: 'balanced',
        label: 'Balanced',
        volumeRamp: 0.06,
        secondBlockBoost: 0.02,
        recoveryMultiplier: 0.75,
        powerStep: 6,
        powerBiasPct: 0,
        weeklyPowerRampPct: 0.006,
        progressionCycle: 3,
    },
    aggressive: {
        key: 'aggressive',
        label: 'Aggressive',
        volumeRamp: 0.09,
        secondBlockBoost: 0.03,
        recoveryMultiplier: 0.74,
        powerStep: 9,
        powerBiasPct: 0.02,
        weeklyPowerRampPct: 0.01,
        progressionCycle: 2,
    },
    very_aggressive: {
        key: 'very_aggressive',
        label: 'Very Aggressive',
        volumeRamp: 0.12,
        secondBlockBoost: 0.04,
        recoveryMultiplier: 0.72,
        powerStep: 12,
        powerBiasPct: 0.04,
        weeklyPowerRampPct: 0.014,
        progressionCycle: 2,
    },
};

const normalizeApproachKey = (approach) => {
    const normalized = String(approach || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (normalized === 'veryaggressive') return 'very_aggressive';
    return normalized;
};

const getApproachRank = (approach) => {
    const key = normalizeApproachKey(approach);
    const ranks = {
        conservative: 0,
        moderate: 1,
        balanced: 2,
        aggressive: 3,
        very_aggressive: 4,
    };
    return Number.isFinite(ranks[key]) ? ranks[key] : ranks.balanced;
};

const getApproachFitConfidence = (selectedKey, suggested) => {
    const base = Number(suggested?.confidence || 50);
    const distance = Math.abs(getApproachRank(selectedKey) - getApproachRank(suggested?.key || 'balanced'));
    if (distance === 0) return Math.max(25, Math.min(99, Math.round(base)));

    const penalties = [0, 18, 36, 52, 66];
    const penalty = penalties[Math.min(distance, penalties.length - 1)];
    return Math.max(8, Math.min(99, Math.round(base - penalty)));
};

const getApproachConfig = (approach) => {
    const key = normalizeApproachKey(approach);
    return TRAINING_APPROACHES[key] || TRAINING_APPROACHES.balanced;
};

const getCompletedRecentWorkouts = (workouts = [], lookbackDays = 56) => {
    const nowTs = Date.now();
    const cutoffTs = nowTs - (lookbackDays * 24 * 60 * 60 * 1000);
    return workouts.filter((workout) => {
        const ts = new Date(workout?.date || workout?.start_time).getTime();
        return Number.isFinite(ts)
            && ts >= cutoffTs
            && ts <= nowTs
            && getWorkoutCompletionStatus(workout) === 'completed';
    });
};

const inferWorkoutIntervalZone = (workout, effectiveRef = 250) => {
    if (!workout) return null;

    const explicit = String(workout.planned_interval_zone || '').trim().toLowerCase();
    if (explicit) return explicit;

    const title = String(workout.title || workout.name || '').toLowerCase();
    if (title.includes('vo2')) return 'vo2max';
    if (title.includes('threshold')) return 'threshold';
    if (title.includes('tempo')) return 'tempo';
    if (title.includes('anaerobic') || title.includes('sprint')) return 'anaerobic';

    const hasStructured = Number(workout.structured_reps || 0) > 0
        && Number(workout.structured_interval_mins || 0) > 0;
    if (!hasStructured) return null;

    const low = Number(workout.structured_power_low || workout.structured_target_avg || workout.normalized_power || workout.avg_power || 0);
    const ratio = effectiveRef > 0 ? (low / effectiveRef) : 0;

    if (ratio >= 1.18) return 'anaerobic';
    if (ratio >= 1.05) return 'vo2max';
    if (ratio >= 0.9) return 'threshold';
    if (ratio >= 0.75) return 'tempo';
    return null;
};

export const suggestTrainingApproach = (analysis, responderProfile = null, workouts = [], availabilityHours = 6) => {
    const safeResponder = responderProfile || analyzeResponderProfile(analysis || { adaptations: [], workouts: [] }, {});
    const recent = getCompletedRecentWorkouts(workouts, 42);

    const successScores = recent
        .map((w) => Number(w?.success_score))
        .filter((score) => Number.isFinite(score) && score > 0);
    const avgSuccessScore = successScores.length
        ? (successScores.reduce((acc, score) => acc + score, 0) / successScores.length)
        : 78;

    const recentFeeling = recent
        .map((w) => Number(w?.feeling_strength))
        .filter((value) => Number.isFinite(value) && value > 0);
    const avgFeeling = recentFeeling.length
        ? (recentFeeling.reduce((acc, value) => acc + value, 0) / recentFeeling.length)
        : 6;

    const stagnationPenalty = analysis?.stagnationZones?.length ? Math.min(15, analysis.stagnationZones.length * 4) : 0;
    const volumeScore = Number(safeResponder?.volumeResponderScore || 0);
    const intensityScore = Number(safeResponder?.intensityResponderScore || 0);
    const confidence = Number(safeResponder?.confidence || 0);

    let aggressivenessScore = 50;
    aggressivenessScore += Math.min(15, (availabilityHours - 6) * 2);
    aggressivenessScore += Math.min(20, (avgSuccessScore - 75) * 0.6);
    aggressivenessScore += Math.min(10, (avgFeeling - 6) * 2);
    aggressivenessScore += Math.min(12, (intensityScore - volumeScore) * 0.2);
    aggressivenessScore -= stagnationPenalty;

    let key = 'balanced';
    if (aggressivenessScore < 38) key = 'conservative';
    else if (aggressivenessScore < 48) key = 'moderate';
    else if (aggressivenessScore < 63) key = 'balanced';
    else if (aggressivenessScore < 74) key = 'aggressive';
    else key = 'very_aggressive';

    const rationaleParts = [];
    if (intensityScore > volumeScore + 8) rationaleParts.push('Recent response profile favors intensity development.');
    if (volumeScore > intensityScore + 8) rationaleParts.push('Recent response profile favors durability and steady volume.');
    if (avgSuccessScore >= 88) rationaleParts.push('Execution quality has been strong, allowing faster progression.');
    if (avgFeeling <= 5.5) rationaleParts.push('Recent recovery markers suggest caution with progression speed.');
    if (analysis?.stagnationZones?.length) rationaleParts.push('Past stagnation under high load tempers aggressiveness.');

    return {
        key,
        label: getApproachConfig(key).label,
        confidence: Math.max(35, Math.min(95, Math.round((confidence * 0.55) + (Math.abs(aggressivenessScore - 50) * 0.8)))),
        rationale: rationaleParts.join(' ') || 'Balanced progression is recommended from current history trends.',
    };
};

/**
 * Generates goal-specific zone modifiers based on training goal.
 * Returns base percentages for each zone type.
 */
const getGoalZoneModifiers = (goal) => {
    const goalLower = goal?.toLowerCase() || '';

    // Define zone distributions for each goal
    const modifiers = {
        endurance: {
            recovery: 0.10,      // 10%
            endurance: 0.70,     // 70% - Foundation of long, steady efforts
            tempo: 0.12,         // 12%
            threshold: 0.05,     // 5%
            vo2max: 0.03         // 3%
        },
        climbing: {
            recovery: 0.10,      // 10%
            endurance: 0.30,     // 30% - Base fitness
            tempo: 0.25,         // 25% - Sustained climbing power
            threshold: 0.25,     // 25% - Critical for climbs
            vo2max: 0.10         // 10% - Quick changes in pace
        },
        speed: {
            recovery: 0.10,      // 10%
            endurance: 0.25,     // 25% - Fitness base
            tempo: 0.15,         // 15%
            threshold: 0.20,     // 20%
            vo2max: 0.20,        // 20% - Power surges
            anaerobic: 0.10      // 10% - Short bursts
        }
    };

    // Match goal to modifiers
    if (goalLower.includes('endurance')) return modifiers.endurance;
    if (goalLower.includes('climbing')) return modifiers.climbing;
    if (goalLower.includes('speed')) return modifiers.speed;

    // Default balanced
    return {
        recovery: 0.12,
        endurance: 0.50,
        tempo: 0.18,
        threshold: 0.12,
        vo2max: 0.08
    };
};

/**
 * Blends historical success patterns with goal modifiers.
 * Returns weighted zone distribution considering what has worked + target goal.
 */
const blendHistoryWithGoal = (analysis, goal, avgSuccessVol, responderProfile = null) => {
    const goalModifiers = getGoalZoneModifiers(goal);

    // If we have strong historical patterns, weight them 50%
    // Goal gets 40%, and base distribution gets 10%
    const historyWeight = analysis.adaptations.length > 0 ? 0.50 : 0.20;
    const goalWeight = 0.40;
    const baseWeight = 1 - historyWeight - goalWeight;

    // Base distribution (neutral)
    const baseDistribution = {
        recovery: 0.12,
        endurance: 0.50,
        tempo: 0.18,
        threshold: 0.12,
        vo2max: 0.08
    };

    // Historical pattern uses the trained local model when available.
    let historicalPattern = responderProfile?.bestHistoricalMix
        ? { ...baseDistribution, ...responderProfile.bestHistoricalMix }
        : { ...baseDistribution };

    if (!responderProfile?.bestHistoricalMix && analysis.adaptations.length > 0) {
        const recentAdaptations = analysis.adaptations.slice(-5);
        const hasVolumeGains = recentAdaptations.some(a => a.improvements?.includes('Consistent Volume Growth'));
        const hasIntensityGains = recentAdaptations.some(a =>
            a.improvements?.some(i => i.includes('VO2 Max') || i.includes('Threshold'))
        );

        if (hasVolumeGains && !hasIntensityGains) {
            historicalPattern = { recovery: 0.10, endurance: 0.65, tempo: 0.15, threshold: 0.08, vo2max: 0.02 };
        } else if (hasIntensityGains && !hasVolumeGains) {
            historicalPattern = { recovery: 0.12, endurance: 0.35, tempo: 0.20, threshold: 0.20, vo2max: 0.13 };
        }
    }

    // Blend all three
    const blended = {
        recovery: historicalPattern.recovery * historyWeight + goalModifiers.recovery * goalWeight + baseDistribution.recovery * baseWeight,
        endurance: historicalPattern.endurance * historyWeight + goalModifiers.endurance * goalWeight + baseDistribution.endurance * baseWeight,
        tempo: historicalPattern.tempo * historyWeight + goalModifiers.tempo * goalWeight + baseDistribution.tempo * baseWeight,
        threshold: historicalPattern.threshold * historyWeight + goalModifiers.threshold * goalWeight + baseDistribution.threshold * baseWeight,
        vo2max: historicalPattern.vo2max * historyWeight + goalModifiers.vo2max * goalWeight + baseDistribution.vo2max * baseWeight
    };

    if (goalModifiers.anaerobic) {
        blended.anaerobic = goalModifiers.anaerobic * goalWeight;
    }

    return blended;
};

// --- Interval Prescription Engine ---

/**
 * Progression levels for structured intervals above endurance zone.
 * Each level is harder (longer interval or more reps) than the previous.
 */
const INTERVAL_PROGRESSIONS = {
    tempo: [
        { reps: 4, intervalMins: 8,    restMins: 4, pctLow: 0.76, pctHigh: 0.90 }, // L0 – baseline
        { reps: 4, intervalMins: 10,   restMins: 4, pctLow: 0.76, pctHigh: 0.88 }, // L1
        { reps: 4, intervalMins: 12,   restMins: 3, pctLow: 0.76, pctHigh: 0.88 }, // L2
        { reps: 5, intervalMins: 10,   restMins: 3, pctLow: 0.77, pctHigh: 0.89 }, // L3
        { reps: 3, intervalMins: 15,   restMins: 4, pctLow: 0.78, pctHigh: 0.90 }, // L4
        { reps: 3, intervalMins: 20,   restMins: 5, pctLow: 0.80, pctHigh: 0.90 }, // L5
    ],
    threshold: [
        { reps: 4, intervalMins: 4,  restMins: 4, pctLow: 0.95, pctHigh: 1.05 }, // L0 – baseline
        { reps: 4, intervalMins: 5,  restMins: 4, pctLow: 0.95, pctHigh: 1.05 }, // L1
        { reps: 4, intervalMins: 6,  restMins: 4, pctLow: 0.95, pctHigh: 1.05 }, // L2
        { reps: 3, intervalMins: 8,  restMins: 4, pctLow: 0.95, pctHigh: 1.05 }, // L3
        { reps: 2, intervalMins: 12, restMins: 6, pctLow: 0.95, pctHigh: 1.05 }, // L4
        { reps: 2, intervalMins: 15, restMins: 6, pctLow: 0.95, pctHigh: 1.05 }, // L5
    ],
    vo2max: [
        { reps: 4, intervalMins: 2, restMins: 4, pctLow: 1.08, pctHigh: 1.20 }, // L0 – baseline
        { reps: 5, intervalMins: 2, restMins: 4, pctLow: 1.08, pctHigh: 1.20 }, // L1
        { reps: 6, intervalMins: 2, restMins: 4, pctLow: 1.08, pctHigh: 1.20 }, // L2
        { reps: 4, intervalMins: 3, restMins: 4, pctLow: 1.08, pctHigh: 1.18 }, // L3
        { reps: 5, intervalMins: 3, restMins: 4, pctLow: 1.08, pctHigh: 1.18 }, // L4
        { reps: 4, intervalMins: 4, restMins: 4, pctLow: 1.06, pctHigh: 1.16 }, // L5
    ],
    anaerobic: [
        { reps: 6, intervalMins: 0.5,  restMins: 2, pctLow: 1.30, pctHigh: 1.50 }, // L0
        { reps: 8, intervalMins: 0.5,  restMins: 2, pctLow: 1.30, pctHigh: 1.50 }, // L1
        { reps: 6, intervalMins: 0.75, restMins: 2, pctLow: 1.25, pctHigh: 1.45 }, // L2
        { reps: 8, intervalMins: 0.75, restMins: 2, pctLow: 1.25, pctHigh: 1.45 }, // L3
        { reps: 6, intervalMins: 1,    restMins: 3, pctLow: 1.20, pctHigh: 1.40 }, // L4
    ],
};

const isExecutionSuccess = (workout) => {
    if (!workout) return false;
    if (workout.execution_success === true) return true;
    if (typeof workout.success_score === 'number') return workout.success_score >= 80;

    const completed = workout.completed === true || workout.completion_status === 'completed';
    const rpe = Number(workout.rpe || 0);
    const feeling = Number(workout.feeling_strength || 0);
    const plannedTarget = Number(workout.structured_target_avg || 0);
    const achievedPower = Number(workout.normalized_power || workout.avg_power || 0);
    const hasObjectiveTargetHit = plannedTarget > 0 && achievedPower >= plannedTarget * 0.92;
    const subjectivePass = (feeling >= 7) || (rpe > 0 && rpe <= 8 && feeling >= 6);

    return completed && (hasObjectiveTargetHit || subjectivePass);
};

const getTargetLowFromHistory = (workouts, zone, baseLow, effectiveRef = 250) => {
    if (!Array.isArray(workouts) || workouts.length === 0) return baseLow;

    const recentStructured = workouts
        .filter(w =>
            inferWorkoutIntervalZone(w, effectiveRef) === zone &&
            typeof w?.structured_power_low === 'number' &&
            (w?.completed === true || w?.completion_status === 'completed')
        )
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!recentStructured.length) return baseLow;

    const last = recentStructured[0];
    const lastLow = Number(last.structured_power_low) || baseLow;

    // Keep this as a conservative anchor; progression logic decides when to add watts.
    return Math.max(baseLow, lastLow);
};

const getWorkoutCompletionStatus = (workout) => {
    if (!workout) return 'completed';
    if (workout.completion_status) return workout.completion_status;
    if (workout.completed === true) return 'completed';
    if (workout.planned === true || workout.plan_source === 'four_week') return 'planned';
    return 'completed';
};

const calculateRecentAverageVolume = (workouts, lookbackDays = 28) => {
    if (!Array.isArray(workouts) || workouts.length === 0) return 0;

    const nowTs = Date.now();
    const cutoffTs = nowTs - (lookbackDays * 24 * 60 * 60 * 1000);
    const qualifying = workouts.filter(w => {
        const ts = new Date(w.date || w.start_time).getTime();
        if (!Number.isFinite(ts) || ts < cutoffTs || ts > nowTs) return false;
        return getWorkoutCompletionStatus(w) === 'completed';
    });

    const totalHours = qualifying.reduce((acc, w) => acc + ((w.total_elapsed_time || 0) / 3600), 0);
    const weeks = lookbackDays / 7;
    return weeks > 0 ? (totalHours / weeks) : 0;
};

const getIntervalBlockMins = (reps, intervalMins, restMins) => {
    if (reps <= 0 || intervalMins <= 0) return 0;
    const rests = Math.max(0, reps - 1);
    return (reps * intervalMins) + (rests * Math.max(0, restMins));
};

const getReservedWarmupCooldownMins = (sessionMins) => {
    if (sessionMins <= 45) return 10;
    if (sessionMins <= 75) return 12;
    if (sessionMins <= 105) return 15;
    return 20;
};

const SESSION_TYPE_LABELS = {
    tempo: 'Tempo',
    threshold: 'Threshold',
    vo2max: 'VO2 Max',
    anaerobic: 'Anaerobic'
};

const STRUCTURED_HISTORY_LOOKBACK_DAYS = 42;
const TARGET_BAND_WATTS = 10;

const buildPowerBand = (low) => {
    const powerLow = Math.max(1, Math.round(low));
    return {
        powerLow,
        powerHigh: powerLow + TARGET_BAND_WATTS,
    };
};

const getCycleWeek = (weekNumber = 1) => ((Math.max(1, Number(weekNumber)) - 1) % 4) + 1;

const getZonePowerStep = (zone, approachConfig, cycleWeek) => {
    const baseStep = Number(approachConfig?.powerStep || 3);
    if (cycleWeek === 4) return -Math.max(2, Math.round(baseStep * 1.5));
    if (cycleWeek === 3) {
        if (zone === 'vo2max' || zone === 'anaerobic') return Math.max(3, baseStep + 1);
        return baseStep + 1;
    }
    if (cycleWeek === 2) {
        if (zone === 'tempo') return Math.max(1, baseStep - 1);
        return baseStep;
    }
    return 0;
};

const getZonePowerFactor = (zone) => {
    const factors = {
        tempo: 0.6,
        threshold: 0.85,
        vo2max: 1.0,
        anaerobic: 1.1,
    };
    return factors[zone] || 1.0;
};

const clampTargetForZone = (targetLow, zone, effectiveRef) => {
    const bounds = {
        tempo: [0.74, 0.93],
        threshold: [0.9, 1.08],
        vo2max: [1.03, 1.24],
        anaerobic: [1.16, 1.58],
    };
    const [lowPct, highPct] = bounds[zone] || [0.6, 1.6];
    const minW = Math.round(effectiveRef * lowPct);
    const maxW = Math.round(effectiveRef * highPct);
    return Math.max(minW, Math.min(maxW, Math.round(targetLow)));
};

const adjustIntervalDetailsForWeek = (details, zone, weekNumber, effectiveRef, approachConfig = TRAINING_APPROACHES.balanced) => {
    if (!details) return details;

    const cycleWeek = getCycleWeek(weekNumber);
    const progressionAllowed = details.canProgress !== false;
    if (!progressionAllowed && cycleWeek !== 4) {
        return details;
    }
    const adjusted = { ...details };
    const powerStep = getZonePowerStep(zone, approachConfig, cycleWeek);
    const zoneFactor = getZonePowerFactor(zone);
    const biasWatts = Math.round((effectiveRef || 250) * Number(approachConfig?.powerBiasPct || 0) * zoneFactor);
    const weekRampDirection = cycleWeek === 4 ? -1 : Math.max(0, cycleWeek - 1);
    const weekRampWatts = Math.round((effectiveRef || 250) * Number(approachConfig?.weeklyPowerRampPct || 0) * weekRampDirection * zoneFactor);
    let targetLow = Number(adjusted.powerLow || 0) + powerStep + biasWatts + weekRampWatts;

    if (cycleWeek === 2) {
        if (zone === 'tempo' || zone === 'threshold') {
            adjusted.intervalMins = Number((Number(adjusted.intervalMins || 0) + 0.5).toFixed(1));
        } else {
            adjusted.reps = Math.max(2, Number(adjusted.reps || 0) + 1);
        }
    }

    if (cycleWeek === 3) {
        if (zone === 'tempo' || zone === 'threshold') {
            adjusted.intervalMins = Number((Number(adjusted.intervalMins || 0) + 1).toFixed(1));
            adjusted.reps = Math.max(2, Number(adjusted.reps || 0) + 1);
        } else {
            adjusted.intervalMins = Number((Number(adjusted.intervalMins || 0) + 0.5).toFixed(1));
            adjusted.reps = Math.max(2, Number(adjusted.reps || 0) + 1);
        }
    }

    if (cycleWeek === 4) {
        adjusted.reps = Math.max(2, Number(adjusted.reps || 0) - 1);
        adjusted.intervalMins = Math.max(1, Number((Number(adjusted.intervalMins || 0) - 0.5).toFixed(1)));
    }

    if (targetLow <= 0) {
        targetLow = Number(adjusted.powerLow || 0);
    }
    const clampedLow = clampTargetForZone(targetLow, zone, effectiveRef || 250);
    const { powerLow, powerHigh } = buildPowerBand(clampedLow);
    adjusted.powerLow = powerLow;
    adjusted.powerHigh = powerHigh;
    adjusted.pctLow = effectiveRef > 0 ? powerLow / effectiveRef : Number(adjusted.pctLow || 0);
    adjusted.pctHigh = effectiveRef > 0 ? powerHigh / effectiveRef : Number(adjusted.pctHigh || 0);

    const dur = Number(adjusted.intervalMins || 0);
    const durLabel = dur < 1 ? `${Math.round(dur * 60)}s` : `${Number.isInteger(dur) ? dur : dur.toFixed(1)}min`;
    adjusted.label = `${adjusted.reps}×${durLabel} @ ${powerLow}-${powerHigh}W (${Math.round(adjusted.pctLow * 100)}-${Math.round(adjusted.pctHigh * 100)}% ref)`;
    adjusted.restLabel = `${adjusted.restMins}min easy recovery between intervals`;

    return adjusted;
};

const getZoneProgressSignal = (workouts = [], zone, baseLow, effectiveRef = 250) => {
    const nowTs = Date.now();
    const cutoffTs = nowTs - (STRUCTURED_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const recent = workouts
        .filter(w => {
            const ts = new Date(w?.date || w?.start_time).getTime();
            return Number.isFinite(ts)
                && ts >= cutoffTs
                && ts <= nowTs
                && inferWorkoutIntervalZone(w, effectiveRef) === zone
                && typeof w?.structured_power_low === 'number'
                && getWorkoutCompletionStatus(w) === 'completed';
        })
        .sort((a, b) => new Date(b.date || b.start_time) - new Date(a.date || a.start_time));

    if (!recent.length) {
        return {
            anchorLow: baseLow,
            lastLow: baseLow,
            lastSuccess: false,
            successRate: 0,
            successStreak: 0,
            sampleSize: 0,
        };
    }

    const last = recent[0];
    const lastLow = Number(last.structured_power_low) || baseLow;
    const bestRecentLow = recent.reduce((acc, workout) => {
        const low = Number(workout.structured_power_low || 0);
        return low > acc ? low : acc;
    }, baseLow);
    const successfulCount = recent.filter(isExecutionSuccess).length;
    let successStreak = 0;
    for (const workout of recent) {
        if (!isExecutionSuccess(workout)) break;
        successStreak += 1;
    }

    return {
        anchorLow: Math.max(baseLow, lastLow, bestRecentLow),
        lastLow,
        bestRecentLow,
        lastSuccess: isExecutionSuccess(last),
        successRate: recent.length ? (successfulCount / recent.length) : 0,
        successStreak,
        sampleSize: recent.length,
    };
};

const getClosestProgressionLevel = (zone, anchor) => {
    const progressions = INTERVAL_PROGRESSIONS[zone] || [];
    if (!anchor || !progressions.length) return 0;

    let bestLevel = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    progressions.forEach((step, index) => {
        const score = Math.abs((step.intervalMins || 0) - (anchor.intervalMins || 0)) * 3
            + Math.abs((step.reps || 0) - (anchor.reps || 0)) * 2
            + Math.abs((step.restMins || 0) - (anchor.restMins || 0));
        if (score < bestScore) {
            bestScore = score;
            bestLevel = index;
        }
    });

    return bestLevel;
};

const getStructuredBlockMinsFromWorkout = (workout) => {
    const reps = Number(workout?.structured_reps || 0);
    const intervalMins = Number(workout?.structured_interval_mins || 0);
    const restMins = Number(workout?.structured_rest_mins || 0);
    return getIntervalBlockMins(reps, intervalMins, restMins);
};

const analyzeStructuredSessionHistory = (workouts = [], effectiveRef = 250) => {
    const zones = ['tempo', 'threshold', 'vo2max', 'anaerobic'];
    const nowTs = Date.now();
    const cutoffTs = nowTs - (STRUCTURED_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    return Object.fromEntries(zones.map(zone => {
        const matching = workouts
            .filter(w => {
                const ts = new Date(w.date || w.start_time).getTime();
                return Number.isFinite(ts)
                    && ts >= cutoffTs
                    && ts <= nowTs
                    && getWorkoutCompletionStatus(w) === 'completed'
                    && inferWorkoutIntervalZone(w, effectiveRef) === zone
                    && Number(w.structured_reps || 0) > 0
                    && Number(w.structured_interval_mins || 0) > 0;
            })
            .map(w => {
                const blockMins = getStructuredBlockMinsFromWorkout(w);
                const powerLow = Number(w.structured_power_low) || Math.round(effectiveRef * 0.9);
                const powerHigh = Number(w.structured_power_high) || (powerLow + TARGET_BAND_WATTS);
                const ts = new Date(w.date || w.start_time).getTime();
                const recencyDays = Math.max(0, (nowTs - ts) / (24 * 60 * 60 * 1000));
                const successBoost = w.execution_success === true ? 40 : 0;
                const objectiveBoost = isExecutionSuccess(w) ? 25 : 0;
                const scoreBoost = Number(w.success_score || 0);
                const recencyBoost = Math.max(0, 30 - recencyDays);
                return {
                    workout: w,
                    reps: Number(w.structured_reps),
                    intervalMins: Number(w.structured_interval_mins),
                    restMins: Number(w.structured_rest_mins || 0),
                    powerLow,
                    powerHigh,
                    blockMins,
                    score: successBoost + objectiveBoost + scoreBoost + blockMins + recencyBoost + (powerLow / 8),
                    sessionHours: Math.max((Number(w.total_elapsed_time || 0) / 3600), (blockMins + getReservedWarmupCooldownMins(blockMins)) / 60),
                };
            })
            .sort((a, b) => b.score - a.score || new Date(b.workout.date) - new Date(a.workout.date));

        if (!matching.length) return [zone, null];

        const anchor = matching[0];
        return [zone, {
            zone,
            anchor,
            startingLevel: getClosestProgressionLevel(zone, anchor),
            minSessionHours: Math.max(anchor.sessionHours, (anchor.blockMins + getReservedWarmupCooldownMins(anchor.blockMins)) / 60),
            frequency: matching.length / (STRUCTURED_HISTORY_LOOKBACK_DAYS / 7),
            label: `${anchor.reps}×${anchor.intervalMins}min`,
            lastDate: anchor.workout.date,
        }];
    }));
};

const getIntensitySessionLimit = (availabilityHours, daysAvailable) => {
    if (daysAvailable <= 3 || availabilityHours < 4.5) return 1;
    if (daysAvailable <= 5 || availabilityHours < 7.5) return 2;
    return 3;
};

const rankIntensityZones = (zoneDistribution, structuredHistory = {}) => {
    return ['tempo', 'threshold', 'vo2max', 'anaerobic']
        .map(zone => {
            const history = structuredHistory[zone];
            const distributionScore = (zoneDistribution?.[zone] || 0) * 100;
            const historyScore = history ? 30 + Math.min(20, history.anchor.blockMins / 2) + Math.min(15, history.frequency * 8) : 0;
            return { zone, score: distributionScore + historyScore, history };
        })
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score);
};

const buildProgressedStructuredPrescription = (zone, exposureIndex, structuredHistory, effectiveRef, workouts = [], approachConfig = TRAINING_APPROACHES.balanced) => {
    const history = structuredHistory?.[zone];
    if (!history?.anchor) {
        return buildIntervalPrescription(zone, 0, 1, effectiveRef, workouts);
    }

    const base = history.anchor;
    let reps = base.reps;
    let intervalMins = base.intervalMins;
    const restMins = base.restMins;
    const signal = getZoneProgressSignal(workouts, zone, base.powerLow, effectiveRef);
    let powerLow = signal.anchorLow;
    let canProgress = true;

    if (exposureIndex > 0) {
        const readinessStrong = signal.lastSuccess && signal.successRate >= 0.55;
        const hasStrongCapability = (signal.bestRecentLow - base.powerLow) >= 6;
        canProgress = readinessStrong || hasStrongCapability;
        if (canProgress) {
            const shouldIncreasePower = hasStrongCapability
                || (signal.successStreak >= 2 && (exposureIndex % Math.max(2, approachConfig.progressionCycle || 3) === 0));
            if (shouldIncreasePower) {
                powerLow += approachConfig.powerStep || 3;
            } else if (zone === 'tempo' || zone === 'threshold') {
                intervalMins += 1;
                if (exposureIndex % 2 === 0) reps += 1;
            } else {
                intervalMins = Number((intervalMins + 0.5).toFixed(1));
                if (exposureIndex % 2 === 0) reps += 1;
            }
        } else if (!signal.lastSuccess && exposureIndex >= 2) {
            reps = Math.max(2, reps - 1);
        }
    }

    const { powerLow: bandLow, powerHigh } = buildPowerBand(powerLow);
    const durLabel = intervalMins < 1 ? `${Math.round(intervalMins * 60)}s` : `${intervalMins}min`;

    return {
        reps,
        intervalMins,
        restMins,
        powerLow: bandLow,
        powerHigh,
        pctLow: effectiveRef > 0 ? bandLow / effectiveRef : base.powerLow / Math.max(effectiveRef, 1),
        pctHigh: effectiveRef > 0 ? powerHigh / effectiveRef : powerHigh / Math.max(effectiveRef, 1),
        level: history.startingLevel,
        label: `${reps}×${durLabel} @ ${bandLow}-${powerHigh}W (${Math.round((effectiveRef > 0 ? bandLow / effectiveRef : 0) * 100)}-${Math.round((effectiveRef > 0 ? powerHigh / effectiveRef : 0) * 100)}% ref)`,
        restLabel: `${restMins}min easy recovery between intervals`,
        source: 'history',
        canProgress,
    };
};

const createIntervalSessionCandidate = (zone, requestedHours, structuredHistory, effectiveRef, workouts = [], exposureIndex = 0, approachConfig = TRAINING_APPROACHES.balanced, weekNumber = 1) => {
    const history = structuredHistory?.[zone];
    const cycleWeek = getCycleWeek(weekNumber);
    const details = history?.anchor
        ? buildProgressedStructuredPrescription(zone, exposureIndex, structuredHistory, effectiveRef, workouts, approachConfig)
        : buildIntervalPrescription(zone, history?.startingLevel || 0, cycleWeek, effectiveRef, workouts);
    if (!details) return null;

    const progressedDetails = adjustIntervalDetailsForWeek(details, zone, weekNumber, effectiveRef, approachConfig);

    const workBlockMins = getIntervalBlockMins(progressedDetails.reps, progressedDetails.intervalMins, progressedDetails.restMins);
    const minimumSessionHours = Math.max(requestedHours || 0, (workBlockMins + getReservedWarmupCooldownMins(workBlockMins)) / 60, history?.minSessionHours || 0);

    return {
        type: SESSION_TYPE_LABELS[zone] || zone,
        count: 1,
        hoursPerSession: minimumSessionHours,
        totalWeekly: minimumSessionHours,
        intervalZone: zone,
        intervalStartingLevel: history?.startingLevel || 0,
        intervalDetails: ensureIntervalCoverage(progressedDetails, minimumSessionHours),
        priorityScore: (history ? 100 : 0) + workBlockMins,
    };
};

    const fitIntensitySessionsToWeek = (selectedZones, availabilityHours, zoneDistribution, structuredHistory, effectiveRef, workouts, exposureCounts, includeRecovery = false, approachConfig = TRAINING_APPROACHES.balanced, weekNumber = 1) => {
    const sessions = [];
    const minEnduranceHours = availabilityHours >= 4 ? 1.25 : Math.min(1.0, availabilityHours * 0.4);
    const recoveryHours = includeRecovery && availabilityHours >= 5 ? 0.5 : 0;
    const requestedIntensityHours = selectedZones.map(({ zone }) => ({
        zone,
        hours: Math.max(availabilityHours * (zoneDistribution?.[zone] || 0), structuredHistory?.[zone]?.minSessionHours || 0)
    }));

    const intensitySessions = [];
    requestedIntensityHours.forEach(({ zone, hours }) => {
        const candidate = createIntervalSessionCandidate(zone, hours, structuredHistory, effectiveRef, workouts, exposureCounts[zone] || 0, approachConfig, weekNumber);
        if (candidate) intensitySessions.push(candidate);
    });

    let totalIntensityHours = intensitySessions.reduce((acc, session) => acc + session.totalWeekly, 0);
    let availableForEndurance = availabilityHours - recoveryHours - totalIntensityHours;

    while (availableForEndurance < minEnduranceHours && intensitySessions.length > 1) {
        intensitySessions.sort((a, b) => a.priorityScore - b.priorityScore);
        intensitySessions.shift();
        totalIntensityHours = intensitySessions.reduce((acc, session) => acc + session.totalWeekly, 0);
        availableForEndurance = availabilityHours - recoveryHours - totalIntensityHours;
    }

    const enduranceHours = Math.max(minEnduranceHours, availabilityHours - recoveryHours - totalIntensityHours);
    sessions.push({
        type: 'Endurance',
        count: enduranceHours >= 3 ? 2 : 1,
        hoursPerSession: enduranceHours >= 3 ? enduranceHours / 2 : enduranceHours,
        totalWeekly: enduranceHours,
    });

    intensitySessions.forEach(session => sessions.push(session));

    if (recoveryHours > 0) {
        sessions.push({
            type: 'Recovery',
            count: 1,
            hoursPerSession: recoveryHours,
            totalWeekly: recoveryHours,
        });
    }

    return {
        sessions,
        totalWeeklyHours: sessions.reduce((acc, session) => acc + session.totalWeekly, 0),
        sessionsPerWeek: sessions.reduce((acc, session) => acc + session.count, 0),
    };
};

const ensureIntervalCoverage = (details, sessionHours) => {
    if (!details) return details;

    const sessionMins = Math.round((sessionHours || 0) * 60);
    const reservedWarmupCooldownMins = getReservedWarmupCooldownMins(sessionMins);
    const maxWorkBlockMins = Math.max(0, sessionMins - reservedWarmupCooldownMins);
    if (maxWorkBlockMins <= 0) return details;

    const currentBlock = getIntervalBlockMins(details.reps, details.intervalMins, details.restMins);
    if (currentBlock <= maxWorkBlockMins) return details;

    // Start from less intervals for short sessions, preserving interval quality first.
    let fittedReps = details.reps;
    while (fittedReps > 1) {
        const candidate = getIntervalBlockMins(fittedReps, details.intervalMins, details.restMins);
        if (candidate <= maxWorkBlockMins) break;
        fittedReps -= 1;
    }

    // If still too long, progressively trim interval duration (0.5 min steps) and keep at least 1 rep.
    let fittedIntervalMins = details.intervalMins;
    if (getIntervalBlockMins(fittedReps, fittedIntervalMins, details.restMins) > maxWorkBlockMins) {
        while (fittedIntervalMins > 1) {
            const next = Math.max(1, Number((fittedIntervalMins - 0.5).toFixed(1)));
            if (next === fittedIntervalMins) break;
            fittedIntervalMins = next;
            if (getIntervalBlockMins(fittedReps, fittedIntervalMins, details.restMins) <= maxWorkBlockMins) break;
        }
    }

    const durLabel = fittedIntervalMins < 1
        ? `${Math.round(fittedIntervalMins * 60)}s`
        : `${Number.isInteger(fittedIntervalMins) ? fittedIntervalMins : fittedIntervalMins.toFixed(1)}min`;

    return {
        ...details,
        reps: Math.max(1, fittedReps),
        intervalMins: fittedIntervalMins,
        label: `${Math.max(1, fittedReps)}×${durLabel} @ ${details.powerLow}-${details.powerHigh}W (${Math.round(details.pctLow * 100)}-${Math.round(details.pctHigh * 100)}% ref)`,
        restLabel: `${details.restMins}min easy recovery between intervals`,
    };
};

/**
 * Scans the last 8 weeks of power curve data to determine the user's
 * current interval capacity per zone. Returns a starting level (0–5).
 */
const analyzeRecentIntervalCapacity = (workouts, effectiveRef) => {
    const empty = { tempoLevel: 0, thresholdLevel: 0, vo2Level: 0, anaLevel: 0 };
    if (!workouts?.length || !effectiveRef) return empty;

    const cutoff = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000);
    const recent = workouts.filter(w => new Date(w.date) >= cutoff);
    if (!recent.length) return empty;

    // Aggregate best power curve values across all recent workouts
    const best = {};
    recent.forEach(w => {
        if (!w.power_curve) return;
        Object.entries(w.power_curve).forEach(([key, val]) => {
            if (val && (!best[key] || val > best[key])) best[key] = val;
        });
    });

    // Tempo: longest duration sustaining >= 76% of reference power
    const tempoKeys = ['duration_8m', 'duration_10m', 'duration_12m', 'duration_15m', 'duration_20m'];
    let tempoLevel = 0;
    tempoKeys.forEach((k, i) => { if ((best[k] || 0) >= effectiveRef * 0.76) tempoLevel = i + 1; });

    // Threshold: longest duration sustaining >= 91% of reference power
    const thresholdKeys = ['duration_3m', 'duration_5m', 'duration_8m', 'duration_10m', 'duration_12m', 'duration_15m'];
    let thresholdLevel = 0;
    thresholdKeys.forEach((k, i) => { if ((best[k] || 0) >= effectiveRef * 0.91) thresholdLevel = i + 1; });

    // VO2 Max: longest duration sustaining >= 106% of reference power
    const vo2Keys = ['duration_1m', 'duration_2m', 'duration_3m', 'duration_5m'];
    let vo2Level = 0;
    vo2Keys.forEach((k, i) => { if ((best[k] || 0) >= effectiveRef * 1.06) vo2Level = i + 1; });

    // Anaerobic: 1-min power vs thresholds
    let anaLevel = 0;
    if ((best['duration_1m'] || 0) >= effectiveRef * 1.20) anaLevel = 2;
    else if ((best['duration_1m'] || 0) >= effectiveRef * 1.10) anaLevel = 1;

    return {
        tempoLevel:     Math.min(tempoLevel,     5),
        thresholdLevel: Math.min(thresholdLevel, 5),
        vo2Level:       Math.min(vo2Level,       5),
        anaLevel:       Math.min(anaLevel,       4),
    };
};

/**
 * Builds a concrete interval prescription for a given zone/level/week.
 * Week 1: base | Week 2: +1 rep | Week 3: advance one level | Week 4: recover (drop level, -1 rep)
 */
const buildIntervalPrescription = (zone, startingLevel, weekNumber, effectiveRef, workouts = []) => {
    const progressions = INTERVAL_PROGRESSIONS[zone];
    if (!progressions || !effectiveRef) return null;

    let level = startingLevel;
    let repDelta = 0;
    if (weekNumber === 2) { repDelta = 1; }
    else if (weekNumber === 3) { level = Math.min(startingLevel + 1, progressions.length - 1); }
    else if (weekNumber === 4) { level = Math.max(0, startingLevel - 1); repDelta = -1; }

    const t = progressions[level];
    const reps = Math.max(2, t.reps + repDelta);
    const baseLow = Math.round(effectiveRef * t.pctLow);
    const powerLow = getTargetLowFromHistory(workouts, zone, baseLow, effectiveRef);
    const { powerLow: bandLow, powerHigh } = buildPowerBand(powerLow);
    const durLabel  = t.intervalMins < 1 ? `${Math.round(t.intervalMins * 60)}s` : `${t.intervalMins}min`;

    return {
        reps,
        intervalMins: t.intervalMins,
        restMins: t.restMins,
        powerLow: bandLow,
        powerHigh,
        pctLow: effectiveRef > 0 ? bandLow / effectiveRef : t.pctLow,
        pctHigh: effectiveRef > 0 ? powerHigh / effectiveRef : t.pctHigh,
        level,
        label:     `${reps}×${durLabel} @ ${bandLow}-${powerHigh}W (${Math.round((effectiveRef > 0 ? bandLow / effectiveRef : t.pctLow) * 100)}-${Math.round((effectiveRef > 0 ? powerHigh / effectiveRef : t.pctHigh) * 100)}% ref)`,
        restLabel: `${t.restMins}min easy recovery between intervals`,
    };
};

/**
 * Converts zone percentages into a weekly session plan.
 * Considers availability and generates specific session breakdown.
 */
const generateSessionPlan = (zoneDistribution, availabilityHours, avgSuccessVol, daysAvailable = 5, intervalCapacity = null, effectiveRef = 250, workouts = [], structuredHistory = {}, approachConfig = TRAINING_APPROACHES.balanced) => {
    const rankedZones = rankIntensityZones(zoneDistribution, structuredHistory);
    const maxIntensityTypes = getIntensitySessionLimit(availabilityHours, daysAvailable);
    const selectedZones = rankedZones.slice(0, maxIntensityTypes);
    const exposureCounts = Object.fromEntries(rankedZones.map(({ zone }) => [zone, 0]));

    const fitted = fitIntensitySessionsToWeek(
        selectedZones,
        availabilityHours,
        zoneDistribution,
        structuredHistory,
        effectiveRef,
        workouts,
        exposureCounts,
        availabilityHours >= 6 && daysAvailable >= 4,
        approachConfig,
        1
    );

    return {
        sessions: fitted.sessions,
        totalWeeklyHours: Math.round(fitted.totalWeeklyHours * 10) / 10,
        sessionsPerWeek: fitted.sessionsPerWeek,
        zoneRanks: rankedZones,
        maxIntensityTypes,
    };
};

/**
 * Determines progression strategy based on historical data and recommendation.
 * Returns either "Volume" or "Intensity" progression type.
 */
const determineProgressionStrategy = (analysis, availabilityHours, avgSuccessVol, responderProfile = null) => {
    const isTimeConstrained = availabilityHours < avgSuccessVol * 0.8;

    // If time-constrained, focus on intensity progression
    if (isTimeConstrained) return 'Intensity';

    if (responderProfile?.responderType === 'Intensity') return 'Intensity';
    if (responderProfile?.responderType === 'Volume') return 'Volume';

    // Check if user has shown better response to volume
    if (analysis.adaptations.length > 0) {
        const volumeGains = analysis.adaptations.filter(a =>
            a.improvements?.includes('Consistent Volume Growth')
        ).length;

        const intensityGains = analysis.adaptations.filter(a =>
            a.improvements?.some(i => i.includes('VO2 Max') || i.includes('Threshold'))
        ).length;

        if (volumeGains > intensityGains) return 'Volume';
        if (intensityGains > volumeGains) return 'Intensity';
    }

    // Default: balanced, but prefer volume if good availability
    return 'Volume';
};

/**
 * Applies progression multipliers to a session across the 4-week block.
 * Week 1: Base (1.0x), Week 2: +10%, Week 3: +15%, Week 4: -20% (recovery)
 */
const applyWeeklyProgression = (baseSession, weekNumber, progressionType, effectiveRef = 250, workouts = []) => {
    const volumeMultipliers = [1.0, 1.10, 1.15, 0.80]; // Volume progression + recovery week
    const intensityVolumeMultipliers = [1.0, 1.03, 1.05, 0.85]; // Keep volumes steadier for intensity blocks
    const intensityBoosts = [0, 0, 5, -15]; // Intensity: +5% w3, -15% w4 (easier recovery)

    const session = { ...baseSession };

    if (progressionType === 'Volume') {
        session.hoursPerSession = (session.hoursPerSession * volumeMultipliers[weekNumber - 1]);
        session.totalWeekly = session.totalWeekly * volumeMultipliers[weekNumber - 1];
    } else {
        // Intensity progression: small volume changes + intensity emphasis
        const mult = intensityVolumeMultipliers[weekNumber - 1];
        session.hoursPerSession = session.hoursPerSession * mult;
        session.totalWeekly = session.totalWeekly * mult;
        session.intensityBoost = intensityBoosts[weekNumber - 1];
    }

    // Progress interval structure for structured (above-endurance) sessions
    if (baseSession.intervalZone !== undefined && baseSession.intervalStartingLevel !== undefined) {
        const progressed = buildIntervalPrescription(
            baseSession.intervalZone,
            baseSession.intervalStartingLevel,
            weekNumber,
            effectiveRef,
            workouts
        );
        session.intervalDetails = ensureIntervalCoverage(progressed, session.hoursPerSession);
    }

    return session;
};

/**
 * Generates a 4-week progressive training plan.
 * Week 1: Base fitness, Week 2: Build, Week 3: Peak, Week 4: Recovery.
 */
const clampRestWeekCadence = (value) => {
    const cadence = Number(value);
    if (!Number.isFinite(cadence)) return 4;
    if (cadence <= 2) return 2;
    if (cadence === 3) return 3;
    return 4;
};

const isRecoveryWeek = (weekNumber, restWeekCadence = 4) => {
    const cadence = clampRestWeekCadence(restWeekCadence);
    return (weekNumber % cadence) === 0;
};

const buildWeekVolumeMultipliers = (totalWeeks, approachConfig, restWeekCadence = 4) => {
    const cadence = clampRestWeekCadence(restWeekCadence);
    const ramp = approachConfig.volumeRamp || 0.06;
    const secondBlockBoost = approachConfig.secondBlockBoost || 0.02;
    const recoveryMultiplier = approachConfig.recoveryMultiplier || 0.75;
    const multipliers = [];

    for (let week = 1; week <= totalWeeks; week++) {
        const inRecovery = isRecoveryWeek(week, cadence);
        if (inRecovery) {
            multipliers.push(recoveryMultiplier);
            continue;
        }

        const cyclePos = ((week - 1) % cadence) + 1;
        const cycleBuildSpots = Math.max(1, cadence - 1);
        const progressFraction = cycleBuildSpots <= 1 ? 1 : (cyclePos - 1) / (cycleBuildSpots - 1);
        const cycleBoost = Math.floor((week - 1) / cadence) * secondBlockBoost;
        multipliers.push(1 + cycleBoost + (ramp * 2 * Math.max(0, progressFraction)));
    }

    return multipliers;
};

const getWeekZoneSelection = (weekNumber, rankedZones, maxIntensityTypes, restWeekCadence = 4) => {
    const zones = rankedZones.map(entry => entry.zone);
    const cadence = clampRestWeekCadence(restWeekCadence);
    const cycleWeek = ((weekNumber - 1) % cadence) + 1;
    if (isRecoveryWeek(weekNumber, cadence)) return [];
    if (zones.length <= 1) return zones;

    if (cadence <= 2) {
        return zones.slice(0, maxIntensityTypes);
    }

    if (cycleWeek === 1) {
        return zones.slice(0, Math.min(maxIntensityTypes, 2));
    }
    if (cycleWeek === 2) {
        if (zones.length >= 3) return [zones[0], zones[2]].slice(0, maxIntensityTypes);
        return zones.slice(0, maxIntensityTypes);
    }
    if (zones.length >= 3) {
        return [zones[1], zones[2]].slice(0, maxIntensityTypes);
    }
    return zones.slice(0, maxIntensityTypes);
};

const getLocalDayKey = (dateLike) => {
    const d = new Date(dateLike);
    if (Number.isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const resolveConstraintPrecedence = (constraint) => {
    const explicit = String(constraint?.precedence || '').toLowerCase();
    if (explicit === 'hard' || explicit === 'soft') return explicit;
    const type = String(constraint?.type || '').toLowerCase();
    if (['illness', 'sick', 'travel', 'holiday', 'unavailable'].includes(type)) return 'hard';
    return 'soft';
};

const normalizeConstraintReduction = (value) => {
    const raw = Number(value || 0);
    const normalized = raw > 1 ? raw / 100 : raw;
    return Math.max(0, Math.min(0.8, normalized));
};

const resolveConstraintDayPolicy = (dayMatches = []) => {
    if (!Array.isArray(dayMatches) || dayMatches.length === 0) {
        return { mode: 'none', reduction: 0, hasRace: false, hasTaper: false };
    }

    const normalized = dayMatches.map((constraint) => {
        const precedence = resolveConstraintPrecedence(constraint);
        const type = String(constraint?.type || '').toLowerCase();
        return {
            precedence,
            type,
            hardBlock: precedence === 'hard' && constraint?.blockTraining !== false,
            reduction: normalizeConstraintReduction(constraint?.reduceAvailability || 0),
        };
    });

    const hasRace = normalized.some(c => c.type === 'race');
    const hasTaper = normalized.some(c => c.type === 'taper');
    const hasHardBlock = normalized.some(c => c.hardBlock);
    const maxSoftReduction = normalized.reduce((acc, c) => c.precedence === 'soft' ? Math.max(acc, c.reduction) : acc, 0);

    // Deterministic precedence when overlaps exist on the same day:
    // hard block > race > taper > soft.
    if (hasHardBlock) {
        return { mode: 'block', reduction: 0, hasRace, hasTaper };
    }
    if (hasRace) {
        return { mode: 'race', reduction: Math.max(maxSoftReduction, 0.2), hasRace, hasTaper };
    }
    if (hasTaper) {
        return { mode: 'taper', reduction: Math.max(maxSoftReduction, 0.35), hasRace, hasTaper };
    }
    return { mode: maxSoftReduction > 0 ? 'soft' : 'none', reduction: maxSoftReduction, hasRace, hasTaper };
};

const buildConstraintWeekMeta = (plannerConstraints = [], planStartDate = null, totalWeeks = 8) => {
    const defaultStart = addWeeks(startOfWeek(new Date(), { weekStartsOn: 1 }), 1);
    const parsedStart = planStartDate ? new Date(planStartDate) : null;
    const baseStart = parsedStart && !Number.isNaN(parsedStart.getTime())
        ? startOfWeek(parsedStart, { weekStartsOn: 1 })
        : defaultStart;

    const normalized = (plannerConstraints || [])
        .map((constraint) => {
            const startKey = getLocalDayKey(constraint?.startDate);
            const endKey = getLocalDayKey(constraint?.endDate || constraint?.startDate);
            if (!startKey || !endKey) return null;

            const precedence = resolveConstraintPrecedence(constraint);
            const reduceAvailability = normalizeConstraintReduction(constraint?.reduceAvailability || 0);
            const type = String(constraint?.type || '').toLowerCase();

            return {
                startKey,
                endKey,
                precedence,
                type,
                hardBlock: precedence === 'hard' && constraint?.blockTraining !== false,
                reduceAvailability,
            };
        })
        .filter(Boolean);

    return Array.from({ length: totalWeeks }, (_, idx) => {
        const weekNumber = idx + 1;
        const weekStart = addWeeks(baseStart, idx);
        let hardDays = 0;
        let softReduction = 0;
        let hasRace = false;
        let hasTaper = false;

        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
            const day = new Date(weekStart);
            day.setDate(day.getDate() + dayOffset);
            const dayKey = getLocalDayKey(day);
            if (!dayKey) continue;

            const dayMatches = normalized.filter(c => dayKey >= c.startKey && dayKey <= c.endKey);
            if (!dayMatches.length) continue;

            const dayPolicy = resolveConstraintDayPolicy(dayMatches);
            if (dayPolicy.mode === 'block') {
                hardDays += 1;
            } else {
                softReduction = Math.max(softReduction, dayPolicy.reduction || 0);
                if (dayPolicy.mode === 'race') hasRace = true;
                if (dayPolicy.mode === 'taper') hasTaper = true;
            }
        }

        return {
            weekNumber,
            hardDays,
            softReduction,
            hasRace,
            hasTaper,
        };
    });
};

const generateEightWeekPlan = (baseWeeklyPlan, zoneDistribution, availabilityHours, progressionType, effectiveRef = 250, workouts = [], structuredHistory = {}, approachConfig = TRAINING_APPROACHES.balanced, restWeekCadence = 4, plannerConstraints = [], planStartDate = null) => {
    const weeks = [];
    const rankedZones = baseWeeklyPlan.zoneRanks || rankIntensityZones(zoneDistribution, structuredHistory);
    const maxIntensityTypes = baseWeeklyPlan.maxIntensityTypes || getIntensitySessionLimit(availabilityHours, 5);
    const exposureCounts = Object.fromEntries(rankedZones.map(({ zone }) => [zone, 0]));
    const cadence = clampRestWeekCadence(restWeekCadence);
    const weekVolumeMultipliers = buildWeekVolumeMultipliers(8, approachConfig, cadence);
    const weekConstraintMeta = buildConstraintWeekMeta(plannerConstraints, planStartDate, 8);

    for (let week = 1; week <= 8; week++) {
        const constraintMeta = weekConstraintMeta[week - 1] || { hardDays: 0, softReduction: 0, hasRace: false, hasTaper: false };
        const nextWeekMeta = weekConstraintMeta[week] || { hasRace: false, hasTaper: false };
        const isRaceWeek = constraintMeta.hasRace || constraintMeta.hasTaper;
        const isPreRaceWeek = !isRaceWeek && (nextWeekMeta.hasRace || nextWeekMeta.hasTaper);
        const selectedZoneKeys = getWeekZoneSelection(week, rankedZones, maxIntensityTypes, cadence);
        const selectedZones = rankedZones.filter(entry => selectedZoneKeys.includes(entry.zone));
        let targetWeekHours = availabilityHours * weekVolumeMultipliers[week - 1];

        if (isPreRaceWeek) {
            targetWeekHours *= 0.88;
        }
        if (isRaceWeek) {
            targetWeekHours *= 0.65;
        }
        if (constraintMeta.softReduction > 0) {
            targetWeekHours *= (1 - constraintMeta.softReduction);
        }
        if (constraintMeta.hardDays > 0) {
            const availableFraction = Math.max(0, (7 - Math.min(7, constraintMeta.hardDays)) / 7);
            targetWeekHours *= availableFraction;
        }

        const minWeekHours = isRaceWeek || constraintMeta.hardDays >= 5 ? 1.5 : 2.5;
        targetWeekHours = Math.max(targetWeekHours, minWeekHours);

        let weekPlan;
        const forcedRecoveryWeek = isRaceWeek || constraintMeta.hardDays >= 5;
        if (isRecoveryWeek(week, cadence) || forcedRecoveryWeek) {
            if (constraintMeta.hardDays >= 7) {
                weekPlan = {
                    sessions: [],
                    totalWeeklyHours: 0,
                    sessionsPerWeek: 0,
                };
            } else {
            const enduranceHours = Math.max(2, targetWeekHours);
                const maxAvailableDays = Math.max(1, 7 - constraintMeta.hardDays);
                const recoveryRideCount = Math.max(1, Math.min(enduranceHours >= 3 ? 2 : 1, maxAvailableDays));
                weekPlan = {
                    sessions: Array.from({ length: recoveryRideCount }, () => ({
                        type: 'Endurance',
                        count: 1,
                        hoursPerSession: enduranceHours / recoveryRideCount,
                        totalWeekly: enduranceHours / recoveryRideCount,
                    })),
                    totalWeeklyHours: enduranceHours,
                    sessionsPerWeek: recoveryRideCount,
                };
            }
        } else {
            weekPlan = fitIntensitySessionsToWeek(
                selectedZones,
                targetWeekHours,
                zoneDistribution,
                structuredHistory,
                effectiveRef,
                workouts,
                exposureCounts,
                targetWeekHours >= 6,
                approachConfig,
                week
            );
            selectedZoneKeys.forEach(zone => {
                exposureCounts[zone] = (exposureCounts[zone] || 0) + 1;
            });
        }

        const cycleWeek = ((week - 1) % cadence) + 1;
        const focus = isRaceWeek
            ? 'Race Week Taper'
            : isPreRaceWeek
                ? 'Pre-Race Sharpening'
                : isRecoveryWeek(week, cadence)
            ? 'Recovery & Adaptation'
            : cycleWeek === 1
            ? 'Rebuild & Reintroduce'
            : cycleWeek <= Math.max(2, cadence - 1)
                ? 'Focused Load'
                : 'Breakthrough Week';

        weeks.push({
            weekNumber: week,
            sessions: weekPlan.sessions,
            totalWeeklyHours: Math.round(weekPlan.totalWeeklyHours * 10) / 10,
            focus,
            intensity: `${100 + (progressionType === 'Intensity' ? Math.round((weekVolumeMultipliers[week - 1] - 1) * 100) : 0)}%`
        });
    }

    return {
        weeks,
        progressionType,
        totalPlanHours: Math.round(weeks.reduce((acc, w) => acc + w.totalWeeklyHours, 0) * 10) / 10,
        rationale: `This 8-week adaptive block progresses your proven interval sessions first, rotates emphasis across weeks so not every intensity type appears every week, applies a recovery week every ${cadence} week(s), factors in saved planning constraints (including race-taper weeks), and recalculates from the latest completion and feedback data.`
    };
};

const intensityBoosts = [0, 0, 5, -15]; // For reference in other parts

/**
 * Converts zone distribution object to focusZones array for chart display.
 */
const zoneDistributionToChart = (zoneDistribution) => {
    const zoneColors = {
        recovery: '#888888',
        endurance: '#3b82f6',
        tempo: '#22c55e',
        threshold: '#eab308',
        vo2max: '#f97316',
        anaerobic: '#ef4444'
    };

    return Object.entries(zoneDistribution)
        .filter(([_, value]) => value > 0.01) // Filter out tiny percentages
        .map(([zone, percentage]) => ({
            name: zone.charAt(0).toUpperCase() + zone.slice(1),
            value: Math.round(percentage * 100),
            color: zoneColors[zone] || '#999999'
        }));
};

/**
 * Generates specific training recommendation text based on adaptations, phenotype, and availability.
 * Now blends historical success, goals, and availability to create personalized focus zones and session plan.
 */
export const generateRecommendation = (analysis, profile, goal, availabilityHours, daysAvailable = 5, workouts = [], trainingApproach = 'suggested', plannerOptions = {}) => {
    // Compute effective reference power: max(FTP, calculated CP)
    const ftp = profile?.ftp || 250;
    let effectiveRef = ftp;
    const allWorkouts = workouts.length ? workouts : (analysis?.workouts || []);
    if (allWorkouts.length) {
        const allBest = {};
        allWorkouts.forEach(w => {
            if (!w.power_curve) return;
            Object.entries(w.power_curve).forEach(([key, val]) => {
                if (val && (!allBest[key] || val > allBest[key])) allBest[key] = val;
            });
        });
        const cp3m = allBest['duration_3m'];
        const cp20m = allBest['duration_20m'];
        if (cp3m && cp20m) {
            const computedCp = Math.round((cp20m * 1200 - cp3m * 180) / (1200 - 180));
            effectiveRef = Math.max(ftp, computedCp);
        }
    }
    const intervalCapacity = analyzeRecentIntervalCapacity(allWorkouts, effectiveRef);
    const structuredHistory = analyzeStructuredSessionHistory(allWorkouts, effectiveRef);

    if (!analysis || analysis.insufficientData) {
        const fallbackZones = {
            recovery: 0.12,
            endurance: 0.60,
            tempo: 0.15,
            threshold: 0.10,
            vo2max: 0.03
        };

        const fallbackSuggested = {
            key: 'balanced',
            label: 'Balanced',
            confidence: 40,
            rationale: 'Not enough historical adaptation data yet; starting from a balanced progression.'
        };
        const selectedApproachConfig = normalizeApproachKey(trainingApproach) === 'suggested'
            ? getApproachConfig(fallbackSuggested.key)
            : getApproachConfig(trainingApproach);

        return {
            title: "Data Building Phase",
            description: "Keep logging rides! We need more history to build a custom ML model for you.",
            focusZones: zoneDistributionToChart(fallbackZones),
            weeklyPlan: generateSessionPlan(
                fallbackZones,
                availabilityHours,
                5,
                daysAvailable,
                intervalCapacity,
                effectiveRef,
                allWorkouts,
                structuredHistory,
                selectedApproachConfig
            ),
            suggestedApproach: fallbackSuggested,
            trainingApproach: selectedApproachConfig
        };
    }

    // 1. Analyze Adaptation Drivers
    const successfulBlocks = analysis.adaptations.filter(a => a.type === 'Stress Adaptation');
    const avgSuccessVol = successfulBlocks.length ? (successfulBlocks.reduce((acc, b) => acc + b.avgVol, 0) / successfulBlocks.length) : 0;
    const responderProfile = analyzeResponderProfile(analysis, profile);
    const suggestedApproach = suggestTrainingApproach(analysis, responderProfile, allWorkouts, availabilityHours);
    const selectedApproachConfig = normalizeApproachKey(trainingApproach) === 'suggested'
        ? getApproachConfig(suggestedApproach.key)
        : getApproachConfig(trainingApproach);
    const restWeekCadence = clampRestWeekCadence(plannerOptions?.restWeekCadence || 4);
    const plannerConstraints = Array.isArray(plannerOptions?.constraints) ? plannerOptions.constraints : [];
    const plannerStartDate = plannerOptions?.planStartDate || null;
    const selectedApproachConfidence = normalizeApproachKey(trainingApproach) === 'suggested'
        ? Number(suggestedApproach.confidence || 50)
        : getApproachFitConfidence(selectedApproachConfig.key, suggestedApproach);

    // --- SAFETY CHECK: Volume Progression (10% Rule) ---
    // Calculate rolling recent average (last 28 days) from completed, past workouts only.
    let recentAvgVol = calculateRecentAverageVolume(allWorkouts, 28);

    // Fallback for legacy or sparse workouts where durations may be missing.
    if (recentAvgVol <= 0 && analysis.weeklyStats && analysis.weeklyStats.length > 0) {
        const recentWeeks = analysis.weeklyStats.slice(-4);
        if (recentWeeks.length > 0) {
            recentAvgVol = recentWeeks.reduce((acc, w) => acc + (w.volume || 0), 0) / recentWeeks.length;
        }
    }

    // Cap at 110% of recent average (or 3 hours if starting from zero/very low)
    const safeVolumeLimit = Math.max(3, recentAvgVol * 1.1);

    // Determine effective availability
    const effectiveAvailability = Math.min(availabilityHours, safeVolumeLimit);
    const isCapped = effectiveAvailability < availabilityHours;

    // 2. Blend history + goal + availability
    const zoneDistribution = blendHistoryWithGoal(analysis, goal, avgSuccessVol, responderProfile);

    // 3. Generate session breakdown
    const weeklyPlan = generateSessionPlan(
        zoneDistribution,
        effectiveAvailability,
        avgSuccessVol,
        daysAvailable,
        intervalCapacity,
        effectiveRef,
        allWorkouts,
        structuredHistory,
        selectedApproachConfig
    );

    // 4. Determine progression strategy and generate 4-week plan
    const progressionType = determineProgressionStrategy(analysis, effectiveAvailability, avgSuccessVol, responderProfile);
    const fourWeekPlan = generateEightWeekPlan(
        weeklyPlan,
        zoneDistribution,
        effectiveAvailability,
        progressionType,
        effectiveRef,
        allWorkouts,
        structuredHistory,
        selectedApproachConfig,
        restWeekCadence,
        plannerConstraints,
        plannerStartDate
    );

    // 5. Generate narrative
    const phenotype = profile?.phenotype || 'All Rounder';
    let title = "Personalized Training Plan";
    let advice = [];

    // Two distinct metrics: plan-fit confidence (aggressiveness match) vs. the responder block's model-classification confidence below.
    const approachRationale = normalizeApproachKey(trainingApproach) === 'suggested'
        ? suggestedApproach.rationale
        : `Baseline suggestion: **${suggestedApproach.label}** (${Math.round(suggestedApproach.confidence)}% plan-fit confidence).`;
    advice.push(`**Training Approach**: ${selectedApproachConfig.label} — ${Math.round(selectedApproachConfidence)}% plan-fit confidence from recent history. ${approachRationale}`);

    // Safety Warning
    if (isCapped) {
        advice.push(`⚠️ **Safety Limit Applied**: You requested **${availabilityHours}h/week**, but your recent average is **${recentAvgVol.toFixed(1)}h/week**.`);
        advice.push(`To prevent injury and overtraining, we've limited this plan to **${effectiveAvailability.toFixed(1)}h/week** (a safe 10% increase). Consistency beats intensity!`);
    }

    if (responderProfile?.recommendations) {
        const { title: responderTitle, message: responderMessage, zoneRecommendation, progressionTip } = responderProfile.recommendations;
        const responderLines = [`🎯 **${responderTitle}**`, responderMessage];
        if (zoneRecommendation) responderLines.push(zoneRecommendation);
        advice.push(responderLines.join('\n'));

        if (progressionTip) {
            advice.push(`**Progression Tip**: ${progressionTip}`);
        }

        if (responderProfile.hasResponderShift && responderProfile.lastShiftDate) {
            advice.push(`**Responder Shift Detected**: Your recent history suggests your training response changed around **${new Date(responderProfile.lastShiftDate).toLocaleDateString()}**. This plan weights your more recent successful blocks more heavily than older ones.`);
        }
    }

    // Check availability constraint (vs Success)
    // Use effectiveAvailability for comparison
    const isTimeConstrained = effectiveAvailability < avgSuccessVol * 0.8;
    if (isTimeConstrained) {
        title = "Efficiency-Focused Plan";
        if (!isCapped) { // Only show this if not already explaining the cap
            advice.push(`Your history shows success with **${avgSuccessVol.toFixed(1)}h/week**, but you have **${effectiveAvailability.toFixed(1)}h** available.`);
        }
        advice.push(`This plan prioritizes **intensity over volume**—focus on high-quality sessions to maximize your training effect.`);
    } else if (responderProfile?.responderType === 'Intensity') {
        title = 'Intensity Responder Plan';
        advice.push(`Your trained local model currently leans toward **intensity-focused training** with **${responderProfile.intensityResponderScore}% probability**.`);
        advice.push(`This plan keeps enough aerobic support work to stay durable while emphasizing the harder work your history responds to best.`);
    } else if (responderProfile?.responderType === 'Volume') {
        title = "Proven Formula Refined";
        if (!isCapped) {
            advice.push(`Your trained local model currently leans toward **volume-based training** with **${responderProfile.volumeResponderScore}% probability**.`);
            advice.push(`This plan maintains similar volume while tailoring zones to your **${goal || 'balanced'}** goal.`);
        } else {
            advice.push(`Your physiology responds well to volume, so we will build towards that safely.`);
        }
    } else if (responderProfile?.responderType === 'Balanced' || responderProfile?.responderType === 'Mixed') {
        title = "Balanced Formula Refined";
        advice.push(`Your trained local model sees a balanced response, drawing gains from both volume and intensity work.`);
        if (!isCapped) {
            advice.push(`This plan maintains similar volume while tailoring zones to your **${goal || 'balanced'}** goal.`);
        }
    } else if (successfulBlocks.length > 0) {
        title = "Proven Formula Refined";
        if (!isCapped) {
            advice.push(`Your physiology responds well to **volume-based training** (best gains at **${avgSuccessVol.toFixed(1)}h/week**).`);
            advice.push(`This plan maintains similar volume while tailoring zones to your **${goal || 'balanced'}** goal.`);
        } else {
            advice.push(`Your physiology responds well to volume, so we will build towards that safely.`);
        }
    }

    // Goal-specific guidance
    if (goal) {
        advice.push("---");
        const strategy = getPhenotypeStrategy(phenotype, goal);
        advice.push(strategy);
    }

    // Overtraining warnings
    if (analysis.stagnationZones.length > 0) {
        const worst = analysis.stagnationZones.sort((a, b) => b.avgTss - a.avgTss)[0];
        advice.push(`⚠️ **Risk Alert**: You tend to stagnate above **${Math.round(worst.avgTss)} TSS/week**. Stay disciplined about recovery.`);
    }

    return {
        title,
        description: advice.join('\n\n'),
        focusZones: zoneDistributionToChart(zoneDistribution),
        weeklyPlan,
        fourWeekPlan,
        responderProfile,
        suggestedApproach,
        trainingApproach: selectedApproachConfig,
        selectedApproachConfidence,
        plannerSettings: {
            restWeekCadence
        }
    };
};


const getPhenotypeStrategy = (phenotype, goal) => {
    const p = phenotype.toLowerCase();
    const g = goal.toLowerCase();

    if (p.includes('sprinter') && g.includes('climbing')) {
        return "**Gap Closing**: As a Sprinter, sustained climbing is your limiter. We recommend a *Sustained Power Build* focusing on extending your Time-to-Exhaustion (TTE) at Threshold, rather than just raising the ceiling.";
    }
    if (p.includes('sprinter') && g.includes('speed')) {
        return "**Sharpening the Sword**: Your physiology is already tuned for speed. Double down with high-cadence sprints and anaerobic capacity intervals to become unstoppable in the bunch.";
    }
    if (p.includes('time trialist') && g.includes('climbing')) {
        return "**Natural Fit**: Your steady-state power is perfect for climbing. Focus on *weight management* and long Tempo climbs to translate your flat-land power to elevation gain.";
    }

    // Default generic
    return `**Strategic Focus**: Leveraging your **${phenotype}** profile to attack your **${goal}** goal. Focus on specific intervals that mimic your target event demands.`;
};
