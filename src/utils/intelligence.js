import { startOfWeek, endOfWeek, addWeeks } from 'date-fns';
import { trainResponderModel, describeResponderProfile } from './intelligence/mlModel.js';

/**
 * Analyzes the correlation between Training Stress (TSS/Volume) and Performance Adaptations.
 * Looks for blocks where performance Metrics (CP/FTP) improved significantly.
 */
export const analyzeAdaptations = (workouts, metrics, ftpHistory) => {
    if (!workouts || workouts.length < 20) return { insufficientData: true };

    // 1. Create a Time Series of Weekly Stats (TSS, Volume, Intensity Distribution) vs Performance
    const weeklyStats = [];
    const sortedWorkouts = [...workouts].sort((a, b) => new Date(a.date) - new Date(b.date));

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
    let currentWeekStart = startOfWeek(firstDate);

    while (currentWeekStart <= lastDate) {
        const currentWeekEnd = endOfWeek(currentWeekStart);

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

/**
 * Converts zone percentages into a weekly session plan.
 * Considers availability and generates specific session breakdown.
 */
const generateSessionPlan = (zoneDistribution, availabilityHours, avgSuccessVol, daysAvailable = 5) => {
    // Determine intensity vs volume approach
    const isTimeConstrained = availabilityHours < avgSuccessVol * 0.8;

    let sessions = [];
    let totalHours = 0;

    // Recovery sessions (10-15% of time, usually 1x per week)
    const recoveryHours = availabilityHours * (zoneDistribution.recovery || 0.12);
    if (recoveryHours > 0.3) {
        sessions.push({
            type: 'Recovery',
            count: Math.max(1, Math.round(recoveryHours / 0.75)),
            hoursPerSession: recoveryHours / Math.max(1, Math.round(recoveryHours / 0.75)),
            totalWeekly: recoveryHours
        });
        totalHours += recoveryHours;
    }

    // Endurance sessions (base aerobic work)
    const enduranceHours = availabilityHours * (zoneDistribution.endurance || 0.50);
    if (enduranceHours > 0.5) {
        const enduranceCount = isTimeConstrained ? 1 : 2;
        sessions.push({
            type: 'Endurance',
            count: enduranceCount,
            hoursPerSession: enduranceHours / enduranceCount,
            totalWeekly: enduranceHours
        });
        totalHours += enduranceHours;
    }

    // Tempo sessions (sustained sub-threshold)
    const tempoHours = availabilityHours * (zoneDistribution.tempo || 0.18);
    if (tempoHours > 0.4) {
        sessions.push({
            type: 'Tempo',
            count: 1,
            hoursPerSession: tempoHours,
            totalWeekly: tempoHours
        });
        totalHours += tempoHours;
    }

    // Threshold sessions (sustained power)
    const thresholdHours = availabilityHours * (zoneDistribution.threshold || 0.12);
    if (thresholdHours > 0.4) {
        sessions.push({
            type: 'Threshold',
            count: 1,
            hoursPerSession: thresholdHours,
            totalWeekly: thresholdHours
        });
        totalHours += thresholdHours;
    }

    // VO2 Max sessions (high intensity)
    const vo2Hours = availabilityHours * (zoneDistribution.vo2max || 0.08);
    if (vo2Hours > 0.4 && !isTimeConstrained) {
        sessions.push({
            type: 'VO2 Max',
            count: 1,
            hoursPerSession: vo2Hours,
            totalWeekly: vo2Hours
        });
        totalHours += vo2Hours;
    }

    // Anaerobic (only if goal is speed and time allows)
    const anerHours = availabilityHours * (zoneDistribution.anaerobic || 0);
    if (anerHours > 0.3) {
        sessions.push({
            type: 'Anaerobic',
            count: 1,
            hoursPerSession: anerHours,
            totalWeekly: anerHours
        });
        totalHours += anerHours;
    }

    // --- ENFORCE DAY CONSTRAINT (STRICT) ---
    // Loop until we fit within daysAvailable
    while (sessions.reduce((acc, s) => acc + s.count, 0) > daysAvailable) {
        let totalSessions = sessions.reduce((acc, s) => acc + s.count, 0);
        let actionTaken = false;

        // 1. Drop Recovery
        const recoveryIdx = sessions.findIndex(s => s.type === 'Recovery');
        if (recoveryIdx !== -1) {
            sessions.splice(recoveryIdx, 1);
            actionTaken = true;
        }

        // 2. Consolidate Endurance
        if (!actionTaken) {
            const enduranceSessions = sessions.filter(s => s.type === 'Endurance');
            // Case A: Multiple Endurance entries
            if (enduranceSessions.length > 1) {
                const firstIdx = sessions.findIndex(s => s.type === 'Endurance');
                let extraHours = 0;
                for (let i = sessions.length - 1; i > firstIdx; i--) {
                    if (sessions[i].type === 'Endurance') {
                        extraHours += sessions[i].totalWeekly;
                        sessions.splice(i, 1);
                    }
                }
                sessions[firstIdx].totalWeekly += extraHours;
                sessions[firstIdx].count = 1;
                sessions[firstIdx].hoursPerSession = sessions[firstIdx].totalWeekly;
                actionTaken = true;
            }
            // Case B: Single Endurance entry with multiple days
            else if (enduranceSessions.length === 1 && enduranceSessions[0].count > 1) {
                const idx = sessions.findIndex(s => s.type === 'Endurance');
                sessions[idx].count = 1;
                sessions[idx].hoursPerSession = sessions[idx].totalWeekly; // Consolidate to one big ride
                actionTaken = true;
            }
        }

        // 3. Merge Smallest Intensity Session into Endurance
        if (!actionTaken) {
            // Identify non-Endurance sessions
            const candidates = sessions.map((s, i) => ({ ...s, index: i }))
                .filter(s => s.type !== 'Endurance');

            if (candidates.length > 0) {
                // Find the one with lowest hours (least important by volume distribution)
                candidates.sort((a, b) => a.totalWeekly - b.totalWeekly);
                const toMerge = candidates[0];

                // Find Endurance to merge into
                const endIdx = sessions.findIndex(s => s.type === 'Endurance');
                if (endIdx !== -1) {
                    sessions[endIdx].totalWeekly += toMerge.totalWeekly;
                    sessions[endIdx].hoursPerSession = sessions[endIdx].totalWeekly;
                    // Remove the intensity session
                    sessions.splice(toMerge.index, 1);
                } else {
                    // No Endurance? Just drop it (or convert to Endurance? dropping is safer structure-wise)
                    // If we have only 1 day available and it's occupied by a small session, we might want to keep the big one.
                    // But here we are reducing count.
                    sessions.splice(toMerge.index, 1);
                }
                actionTaken = true;
            }
        }

        // 4. Fail-safe: If we stick cant reduce (e.g. 1 Endurance session but we need 0? Should not happen if min days >= 1)
        if (!actionTaken) {
            // Just drop the last session
            if (sessions.length > 0) sessions.pop();
            else break; // Sould not be reachable
        }
    }

    // Recalculate stats
    const finalTotalHours = sessions.reduce((acc, s) => acc + s.totalWeekly, 0);
    const finalCount = sessions.reduce((acc, s) => acc + s.count, 0);

    return {
        sessions,
        totalWeeklyHours: Math.round(finalTotalHours * 10) / 10,
        sessionsPerWeek: finalCount
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
const applyWeeklyProgression = (baseSession, weekNumber, progressionType) => {
    const volumeMultipliers = [1.0, 1.10, 1.15, 0.80]; // Volume progression + recovery week
    const intensityBoosts = [0, 0, 5, -15]; // Intensity: +5% w3, -15% w4 (easier recovery)

    const session = { ...baseSession };

    if (progressionType === 'Volume') {
        session.hoursPerSession = (session.hoursPerSession * volumeMultipliers[weekNumber - 1]);
        session.totalWeekly = session.totalWeekly * volumeMultipliers[weekNumber - 1];
    } else {
        // Intensity progression: keep volume similar, adjust focus intensity
        session.intensityBoost = intensityBoosts[weekNumber - 1];
    }

    return session;
};

/**
 * Generates a 4-week progressive training plan.
 * Week 1: Base fitness, Week 2: Build, Week 3: Peak, Week 4: Recovery.
 */
const generateFourWeekPlan = (baseWeeklyPlan, analysis, availabilityHours, avgSuccessVol, progressionType) => {
    const weeks = [];
    const progressionMultipliers = [1.0, 1.10, 1.15, 0.80];

    for (let week = 1; week <= 4; week++) {
        const multiplier = progressionMultipliers[week - 1];

        // Apply progression to each session
        const weekSessions = baseWeeklyPlan.sessions.map(session =>
            applyWeeklyProgression(session, week, progressionType)
        );

        // Calculate totals for the week
        const weeklyHours = baseWeeklyPlan.totalWeeklyHours * multiplier;

        // Determine focus label
        let focus = '';
        if (week === 1) focus = 'Base Building';
        else if (week === 2) focus = 'Progressive Load';
        else if (week === 3) focus = 'Peak Week';
        else focus = 'Recovery & Adaptation';

        weeks.push({
            weekNumber: week,
            sessions: weekSessions,
            totalWeeklyHours: Math.round(weeklyHours * 10) / 10,
            focus,
            intensity: `${100 + (progressionType === 'Intensity' ? intensityBoosts[week - 1] : 0)}%`
        });
    }

    return {
        weeks,
        progressionType,
        totalPlanHours: Math.round(weeks.reduce((acc, w) => acc + w.totalWeeklyHours, 0) * 10) / 10,
        rationale: progressionType === 'Volume'
            ? `Progressive volume increase (B-B-P-R cycle): Your physiology responds well to volume. Weeks 1-3 build from ${weeks[0].totalWeeklyHours}h → ${weeks[2].totalWeeklyHours}h, week 4 recovers at ${weeks[3].totalWeeklyHours}h.`
            : `Progressive intensity increase: Given time constraints, you'll maintain volume while progressively increasing intensity focus through weeks 1-3, with a recovery week 4.`
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
export const generateRecommendation = (analysis, profile, goal, availabilityHours, daysAvailable = 5) => {
    if (!analysis || analysis.insufficientData) {
        const fallbackZones = {
            recovery: 0.12,
            endurance: 0.60,
            tempo: 0.15,
            threshold: 0.10,
            vo2max: 0.03
        };

        return {
            title: "Data Building Phase",
            description: "Keep logging rides! We need more history to build a custom ML model for you.",
            focusZones: zoneDistributionToChart(fallbackZones),
            weeklyPlan: generateSessionPlan(fallbackZones, availabilityHours, 5, daysAvailable)
        };
    }

    // 1. Analyze Adaptation Drivers
    const successfulBlocks = analysis.adaptations.filter(a => a.type === 'Stress Adaptation');
    const avgSuccessVol = successfulBlocks.length ? (successfulBlocks.reduce((acc, b) => acc + b.avgVol, 0) / successfulBlocks.length) : 0;
    const responderProfile = analyzeResponderProfile(analysis, profile);

    // --- SAFETY CHECK: Volume Progression (10% Rule) ---
    // Calculate recent 4-week average volume
    let recentAvgVol = 0;
    if (analysis.weeklyStats && analysis.weeklyStats.length > 0) {
        // Get last 4 weeks (or fewer if not enough data)
        const recentWeeks = analysis.weeklyStats.slice(-4);
        const validWeeks = recentWeeks.filter(w => w.volume > 0); // Filter out zero weeks? Maybe better to include them if they are real rest? 
        // Let's include them to be conservative/honest about recent load, but maybe exclude strictly empty future weeks if they exist?
        // Assuming weeklyStats are past data.

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
    const weeklyPlan = generateSessionPlan(zoneDistribution, effectiveAvailability, avgSuccessVol, daysAvailable);

    // 4. Determine progression strategy and generate 4-week plan
    const progressionType = determineProgressionStrategy(analysis, effectiveAvailability, avgSuccessVol, responderProfile);
    const fourWeekPlan = generateFourWeekPlan(weeklyPlan, analysis, effectiveAvailability, avgSuccessVol, progressionType);

    // 5. Generate narrative
    const phenotype = profile?.phenotype || 'All Rounder';
    let title = "Personalized Training Plan";
    let advice = [];

    // Safety Warning
    if (isCapped) {
        advice.push(`⚠️ **Safety Limit Applied**: You requested **${availabilityHours}h/week**, but your recent average is **${recentAvgVol.toFixed(1)}h/week**.`);
        advice.push(`To prevent injury and overtraining, we've limited this plan to **${effectiveAvailability.toFixed(1)}h/week** (a safe 10% increase). Consistency beats intensity!`);
    }

    if (responderProfile?.recommendations) {
        advice.push(`🎯 **${responderProfile.recommendations.title}**`);
        advice.push(responderProfile.recommendations.message);
        if (responderProfile.recommendations.zoneRecommendation) {
            advice.push(`**Model Readout**: ${responderProfile.recommendations.zoneRecommendation}`);
        }
        if (responderProfile.recommendations.progressionTip) {
            advice.push(`**Progression Tip**: ${responderProfile.recommendations.progressionTip}`);
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
    } else if (responderProfile?.responderType === 'Volume' || successfulBlocks.length > 0) {
        title = "Proven Formula Refined";
        if (!isCapped) {
            if (responderProfile?.responderType === 'Volume') {
                advice.push(`Your trained local model currently leans toward **volume-based training** with **${responderProfile.volumeResponderScore}% probability**.`);
            } else {
                advice.push(`Your physiology responds well to **volume-based training** (best gains at **${avgSuccessVol.toFixed(1)}h/week**).`);
            }
            advice.push(`This plan maintains similar volume while tailoring zones to your **${goal || 'balanced'}** goal.`);
        } else {
            advice.push(`Your physiology responds well to volume, so we will build towards that safely.`);
        }
    } else if (responderProfile?.responderType === 'Intensity') {
        title = 'Intensity Responder Plan';
        advice.push(`Your trained local model currently leans toward **intensity-focused training** with **${responderProfile.intensityResponderScore}% probability**.`);
        advice.push(`This plan keeps enough aerobic support work to stay durable while emphasizing the harder work your history responds to best.`);
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
        responderProfile
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
