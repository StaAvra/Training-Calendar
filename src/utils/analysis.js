import { subDays, startOfWeek, addWeeks, endOfDay } from 'date-fns';

// Coggan power benchmarks (W/kg) for men and women
const POWER_BENCHMARKS = {
    male: {
        'World class': { sprint: 24.04, anaerobic: 11.50, vo2max: 7.60, threshold: 6.40 },
        'Exceptional': { sprint: 21.05, anaerobic: 10.24, vo2max: 6.46, threshold: 5.42 },
        'Excellent': { sprint: 19.42, anaerobic: 9.55, vo2max: 5.34, threshold: 4.89 },
        'Very good': { sprint: 17.51, anaerobic: 8.74, vo2max: 5.12, threshold: 4.27 },
        'Good': { sprint: 16.43, anaerobic: 8.28, vo2max: 4.70, threshold: 3.91 },
        'Moderate': { sprint: 14.52, anaerobic: 7.48, vo2max: 3.98, threshold: 3.29 },
        'Fair': { sprint: 12.62, anaerobic: 6.67, vo2max: 3.26, threshold: 2.66 },
        'Untrained': { sprint: 10.17, anaerobic: 5.64, vo2max: 2.33, threshold: 1.86 }
    },
    female: {
        'World class': { sprint: 19.42, anaerobic: 9.29, vo2max: 6.61, threshold: 5.69 },
        'Exceptional': { sprint: 17.05, anaerobic: 8.29, vo2max: 5.59, threshold: 4.79 },
        'Excellent': { sprint: 15.76, anaerobic: 7.75, vo2max: 5.04, threshold: 4.29 },
        'Very good': { sprint: 14.25, anaerobic: 7.11, vo2max: 4.39, threshold: 3.72 },
        'Good': { sprint: 13.39, anaerobic: 6.75, vo2max: 4.02, threshold: 3.39 },
        'Moderate': { sprint: 11.88, anaerobic: 6.12, vo2max: 3.37, threshold: 2.82 },
        'Fair': { sprint: 10.37, anaerobic: 5.48, vo2max: 2.72, threshold: 2.14 },
        'Untrained': { sprint: 8.43, anaerobic: 4.67, vo2max: 1.89, threshold: 1.50 }
    }
};

// Compare athlete W/kg metrics to benchmarks and return category per metric and overall
export const classifyPerformanceLevel = (metrics = {}, sex = 'male') => {
    const benchmarks = POWER_BENCHMARKS[sex] || POWER_BENCHMARKS.male;
    // Use benchmarks from Exceptional -> Untrained (drop the top "World class" bin)
    const categoryOrder = ['Exceptional', 'Excellent', 'Very good', 'Good', 'Moderate', 'Fair', 'Untrained'];

    const classify = (value, metric) => {
        if (!value || !metric) return 'Untrained';
        for (const category of categoryOrder) {
            const b = benchmarks[category] && benchmarks[category][metric];
            if (b && value >= b) return category;
        }
        return 'Untrained';
    };

    const categories = {
        sprint: classify(metrics.sprint, 'sprint'),
        anaerobic: classify(metrics.anaerobic, 'anaerobic'),
        vo2max: classify(metrics.vo2max, 'vo2max'),
        threshold: classify(metrics.threshold, 'threshold')
    };

    // Overall level: pick the highest category present across the metrics by order
    for (const cat of categoryOrder) {
        if (Object.values(categories).includes(cat)) return { categories, overallLevel: cat };
    }

    return { categories, overallLevel: 'Untrained' };
};

/**
 * Calculate interpolated performance score using linear interpolation between benchmark categories.
 * Returns a continuous score (0-100+) instead of discrete categories for finer resolution.
 * 
 * @param {number} value - The W/kg value to score
 * @param {string} metric - The metric type ('sprint', 'anaerobic', 'vo2max', 'threshold')
 * @param {string} sex - 'male' or 'female'
 * @returns {number} Interpolated score where 0=Untrained baseline, 100=Exceptional, >100=World class
 */
export const calculateInterpolatedScore = (value, metric, sex = 'male') => {
    if (!value || value <= 0) return 0;

    const benchmarks = POWER_BENCHMARKS[sex] || POWER_BENCHMARKS.male;

    // Category order from lowest to highest with their base scores
    const categories = [
        { name: 'Untrained', score: 0 },
        { name: 'Fair', score: 16.67 },      // 100/6 * 1
        { name: 'Moderate', score: 33.33 },  // 100/6 * 2
        { name: 'Good', score: 50.00 },      // 100/6 * 3
        { name: 'Very good', score: 66.67 }, // 100/6 * 4
        { name: 'Excellent', score: 83.33 }, // 100/6 * 5
        { name: 'Exceptional', score: 100 }, // 100/6 * 6
        { name: 'World class', score: 116.67 } // Allow scores above 100 for world-class
    ];

    // Find which two categories the value falls between
    for (let i = 0; i < categories.length - 1; i++) {
        const lower = categories[i];
        const upper = categories[i + 1];

        const lowerThreshold = benchmarks[lower.name]?.[metric] || 0;
        const upperThreshold = benchmarks[upper.name]?.[metric] || Infinity;

        // Check if value falls in this range
        if (value >= lowerThreshold && value < upperThreshold) {
            // Linear interpolation between lower and upper scores
            const range = upperThreshold - lowerThreshold;
            const position = (value - lowerThreshold) / range;
            const scoreRange = upper.score - lower.score;
            const interpolatedScore = lower.score + (position * scoreRange);

            return Math.round(interpolatedScore * 10) / 10; // Round to 1 decimal place
        }
    }

    // If value is above World class threshold, extrapolate
    const worldClassThreshold = benchmarks['World class']?.[metric];
    if (worldClassThreshold && value >= worldClassThreshold) {
        // Extrapolate beyond 116.67 (allow unlimited ceiling)
        const exceptionalThreshold = benchmarks['Exceptional']?.[metric];
        const range = worldClassThreshold - exceptionalThreshold;
        const excess = value - worldClassThreshold;
        const extrapolation = (excess / range) * 16.67; // Each category is worth 16.67 points
        return Math.round((116.67 + extrapolation) * 10) / 10;
    }

    // Below untrained threshold - give proportional score based on distance from zero
    const untrainedThreshold = benchmarks['Untrained']?.[metric];
    if (untrainedThreshold && value > 0) {
        // Give a score from 0 to just below the Untrained baseline (0)
        // Scale linearly: 0 W/kg = -16.67, Untrained threshold = 0
        const ratio = value / untrainedThreshold;
        const belowUntrainedScore = (ratio - 1) * 16.67; // Will be negative, approaching 0 as value approaches untrained
        return Math.round(belowUntrainedScore * 10) / 10;
    }

    return 0;
};

export const calculateZones = (ftp) => {
    const zones = [
        { name: 'Active Recovery', min: 0, max: ftp * 0.55, color: '#888888' },
        { name: 'Endurance', min: ftp * 0.55, max: ftp * 0.75, color: '#3b82f6' },
        { name: 'Tempo', min: ftp * 0.75, max: ftp * 0.90, color: '#22c55e' },
        { name: 'Threshold', min: ftp * 0.90, max: ftp * 1.05, color: '#eab308' },
        { name: 'VO2 Max', min: ftp * 1.05, max: ftp * 1.20, color: '#f97316' },
        { name: 'Anaerobic', min: ftp * 1.20, max: ftp * 1.50, color: '#ef4444' },
        { name: 'Neuromuscular', min: ftp * 1.50, max: 9999, color: '#a855f7' },
    ];

    return zones.map(z => ({
        ...z,
        range: z.max > 5000 ? `${Math.round(z.min)}+ W` : `${Math.round(z.min)} - ${Math.round(z.max)} W`
    }));
};

export const calculateTimeInZones = (streams, ftp) => {
    if (!streams || !streams.length || !ftp) return [];

    const zones = calculateZones(ftp);
    const distribution = zones.map(z => ({ ...z, time: 0 }));

    streams.forEach(point => {
        if (typeof point.power === 'number') {
            const zoneIndex = zones.findIndex(z => point.power >= z.min && point.power < z.max);
            if (zoneIndex !== -1) {
                distribution[zoneIndex].time += 1;
            }
        }
    });

    return distribution;
};

export const calculateHRZones = (maxHr) => {
    // HR zones as percentages of max heart rate
    const zones = [
        { name: 'Active Recovery', min: 0, max: maxHr * 0.60, color: '#888888' },
        { name: 'Endurance', min: maxHr * 0.60, max: maxHr * 0.70, color: '#3b82f6' },
        { name: 'Tempo', min: maxHr * 0.70, max: maxHr * 0.80, color: '#22c55e' },
        { name: 'Threshold', min: maxHr * 0.80, max: maxHr * 0.90, color: '#eab308' },
        { name: 'VO2 Max', min: maxHr * 0.90, max: maxHr * 0.95, color: '#f97316' },
        { name: 'Anaerobic', min: maxHr * 0.95, max: maxHr * 1.00, color: '#ef4444' },
        { name: 'Max Effort', min: maxHr * 1.00, max: 9999, color: '#a855f7' },
    ];

    return zones.map(z => ({
        ...z,
        range: z.max > 5000 ? `${Math.round(z.min)}+ bpm` : `${Math.round(z.min)} - ${Math.round(z.max)} bpm`
    }));
};

export const calculateTimeInHRZones = (streams, maxHr) => {
    if (!streams || !streams.length || !maxHr) return [];

    const zones = calculateHRZones(maxHr);
    const distribution = zones.map(z => ({ ...z, time: 0 }));

    streams.forEach(point => {
        if (typeof point.heart_rate === 'number') {
            const zoneIndex = zones.findIndex(z => point.heart_rate >= z.min && point.heart_rate < z.max);
            if (zoneIndex !== -1) {
                distribution[zoneIndex].time += 1;
            }
        }
    });

    return distribution;
};

export const calculateIntensityFactor = (workout, ftp) => {
    // IF = NP / FTP
    const np = workout.normalized_power || workout.avg_power;
    if (!np || !ftp) return null;
    return (np / ftp).toFixed(2);
};

export const calculateTSS = (workout, ftp) => {
    // TSS = (sec x NP x IF) / (FTP x 36)
    // or (sec x NP^2) / (FTP^2 x 36)? No, usually IF based formula.
    // Standard: (Duration(s) * NP * IF) / (FTP * 3600) * 100
    // => (s * NP * (NP/FTP)) / (FTP * 36) ...
    // Simplified: (s * NP * IF) / (FTP * 36)

    const s = workout.total_elapsed_time;
    const np = workout.normalized_power || workout.avg_power;

    if (!s) return null;

    // If we have power and FTP, use the standard formula
    if (np && ftp) {
        const if_val = np / ftp;
        const tss = (s * np * if_val) / (ftp * 36);
        return Math.round(tss);
    }

    // Fallback: estimate IF from heart rate and compute TSS from IF
    // This allows estimating TSS for rides without power but with HR data
    if (workout.avg_heart_rate) {
        const hrAvg = workout.avg_heart_rate;
        const restHr = workout.resting_heart_rate || workout.rest_hr || null;
        const chr = workout.critical_heart_rate || workout.estimated_chr || null;

        const ifEstObj = estimateIfFromHr({ hrAvg, restHr, chr, workoutHistory: workout.history || [] });
        if (ifEstObj && typeof ifEstObj.ifEstimate === 'number') {
            const tssEst = estimateTssFromIf(s, ifEstObj.ifEstimate);
            return tssEst.tss;
        }
    }

    return null;
};

/**
 * Calculate TSS with metadata (method and confidence).
 * Useful for UI display showing whether TSS is power-based or HR-estimated.
 * Returns { tss, method, confidence, ifEstimate }
 */
export const calculateTssWithMetadata = (workout, ftp) => {
    const s = workout.total_elapsed_time;
    const np = workout.normalized_power || workout.avg_power;

    if (!s) return { tss: null, method: 'invalid', confidence: 0 };

    // If we have power and FTP, use the standard formula
    if (np && ftp) {
        const if_val = np / ftp;
        const tss = (s * np * if_val) / (ftp * 36);
        return { tss: Math.round(tss), method: 'power-based', confidence: 1.0, ifEstimate: if_val };
    }

    // Fallback: estimate IF from heart rate and compute TSS from IF
    if (workout.avg_heart_rate) {
        const hrAvg = workout.avg_heart_rate;
        const restHr = workout.resting_heart_rate || workout.rest_hr || null;
        const chr = workout.critical_heart_rate || workout.estimated_chr || null;

        const ifEstObj = estimateIfFromHr({ hrAvg, restHr, chr, workoutHistory: workout.history || [] });
        if (ifEstObj && typeof ifEstObj.ifEstimate === 'number') {
            const tssEst = estimateTssFromIf(s, ifEstObj.ifEstimate, ifEstObj.confidence);
            return {
                tss: tssEst.tss,
                method: `hr-based (${ifEstObj.method})`,
                confidence: tssEst.confidence,
                ifEstimate: ifEstObj.ifEstimate
            };
        }
    }

    return { tss: null, method: 'unavailable', confidence: 0 };
};

/**
 * Estimate Intensity Factor (IF) from Heart Rate data.
 * Inputs: object { hrAvg, restHr, chr, workoutHistory }
 * - hrAvg: average heart rate for the workout
 * - restHr: resting heart rate if available
 * - chr: critical heart rate (threshold HR) if available
 * - workoutHistory: optional array of past workouts containing both HR and power to calibrate
 * Returns: { ifEstimate, method, confidence }
 */
export const estimateIfFromHr = ({ hrAvg, restHr = null, chr = null, workoutHistory = [] } = {}) => {
    if (!hrAvg) return null;

    // Derive HR reserve ratio if possible: (HRavg - Rest) / (CHR - Rest)
    let hrRatio = null;
    if (restHr && chr && chr > restHr) {
        hrRatio = (hrAvg - restHr) / (chr - restHr);
    } else if (restHr && !chr) {
        // fallback: approximate chr as 0.9 * maxHR ~ not ideal but usable
        hrRatio = (hrAvg - restHr) / Math.max((restHr * 1.3), 1);
    } else if (!restHr && chr) {
        hrRatio = hrAvg / chr;
    } else {
        // No anchors; assume resting HR ~ 60 and chr ~ 0.9*max (~we can't know max here)
        // Use a conservative mapping hrRatio = hrAvg / 200
        hrRatio = hrAvg / 200;
    }

    // Clamp ratio to reasonable physiologic bounds
    hrRatio = Math.max(0.3, Math.min(1.2, hrRatio));

    // If we have calibration data (historical rides with both HR and power), fit simple linear model
    const samples = [];
    if (Array.isArray(workoutHistory) && workoutHistory.length > 0) {
        for (const w of workoutHistory) {
            const wpAvgHr = w.avg_heart_rate;
            const np = w.normalized_power || w.avg_power;
            const ftp = w.functional_threshold_power || w.ftp || 250; // Fallback to default FTP if needed
            if (wpAvgHr && np) {
                // Build HR ratio for this workout
                const sampleHrRatio = (w.resting_heart_rate && w.critical_heart_rate) ?
                    ((wpAvgHr - w.resting_heart_rate) / (w.critical_heart_rate - w.resting_heart_rate)) : (wpAvgHr / Math.max(w.critical_heart_rate || 200, 1));
                const sampleIf = np / ftp;
                if (Number.isFinite(sampleHrRatio) && Number.isFinite(sampleIf) && sampleHrRatio > 0 && sampleIf > 0) {
                    samples.push({ x: sampleHrRatio, y: sampleIf });
                }
            }
        }
    }

    if (samples.length >= 3) {
        // Simple linear regression y = a*x + b
        const n = samples.length;
        const sumX = samples.reduce((s, p) => s + p.x, 0);
        const sumY = samples.reduce((s, p) => s + p.y, 0);
        const sumXY = samples.reduce((s, p) => s + p.x * p.y, 0);
        const sumX2 = samples.reduce((s, p) => s + p.x * p.x, 0);

        const denom = (n * sumX2 - sumX * sumX);
        let a = 0, b = 0;
        if (denom !== 0) {
            a = (n * sumXY - sumX * sumY) / denom;
            b = (sumY - a * sumX) / n;
        }

        const ifEstimate = a * hrRatio + b;
        const confidence = Math.min(0.99, 0.5 + Math.min(0.5, samples.length / 20));
        return { ifEstimate: Math.max(0.3, Math.min(2.0, ifEstimate)), method: 'calibrated', confidence };
    }

    // Default mapping: assume IF ≈ hrRatio (a reasonable first-approx mapping)
    const ifDefault = hrRatio;
    const confidence = 0.35; // low confidence without calibration
    return { ifEstimate: Math.max(0.3, Math.min(1.6, ifDefault)), method: 'heuristic', confidence };
};

/**
 * Estimate TSS from duration and IF estimate.
 * Uses TSS ≈ (duration_seconds × IF^2) / 36
 * Returns { tss, method, confidence }
 */
export const estimateTssFromIf = (durationSeconds, ifEstimate, confFromIf = 0.5) => {
    if (!durationSeconds || !ifEstimate) return { tss: null, method: 'invalid', confidence: 0 };
    const tss = Math.round((durationSeconds * Math.pow(ifEstimate, 2)) / 36);
    // Combine IF confidence with TSS formula confidence
    const confidence = confFromIf * 0.85; // Slight penalty for derived TSS
    return { tss, method: 'if-derived', confidence };
};

export const checkFtpImprovement = (workouts, currentFtp, profile = {}) => {
    if (!workouts || workouts.length === 0) return null;

    const bestRide = workouts.reduce((max, w) => {
        if (w.total_elapsed_time > 1200 && (w.normalized_power || w.avg_power) > (max?.normalized_power || max?.avg_power || 0)) {
            return w;
        }
        return max;
    }, null);

    const bestPower = bestRide ? (bestRide.normalized_power || bestRide.avg_power) : 0;

    if (bestPower > currentFtp * 1.05) {
        return {
            suggestedUpdate: Math.round(bestPower * 0.95),
            reason: `Detected strong effort on ${new Date(bestRide.date).toLocaleDateString()}. Power: ${Math.round(bestPower)}W`
        };
    }

    // Determine Critical HR (CHR) from available hr_curve data, else fallback to profile.maxHr (~90%),
    // else fallback to observed max avg_heart_rate * 0.95. This avoids using a hard-coded 175 bpm.
    let estimatedChr = null;
    for (const w of workouts) {
        if (w.hr_curve) {
            const chrObj = calculateCriticalHeartRate(w.hr_curve);
            if (chrObj && chrObj.chr) { estimatedChr = chrObj.chr; break; }
        }
    }
    if (!estimatedChr && profile && profile.maxHr) {
        estimatedChr = Math.round(profile.maxHr * 0.90);
    }
    if (!estimatedChr) {
        const maxObserved = workouts.reduce((m, w) => Math.max(m, w.avg_heart_rate || 0), 0);
        if (maxObserved > 0) estimatedChr = Math.round(maxObserved * 0.95);
    }

    const thresholdRide = workouts.find(w =>
        w.total_elapsed_time > 600 &&
        (w.avg_power > currentFtp) &&
        (w.avg_heart_rate && estimatedChr && w.avg_heart_rate < estimatedChr)
    );

    if (thresholdRide) {
        return {
            suggestedUpdate: Math.round(thresholdRide.avg_power),
            reason: `Sustained high power (${Math.round(thresholdRide.avg_power)}W) with HR below estimated CHR (${estimatedChr || 'n/a'}).`
        };
    }

    return null;
};

export const calculatePhenotype = (powerCurve, weight = 70, sex = 'male') => {
    if (!powerCurve || !powerCurve.duration_20m) return { type: 'All-Rounder', adj: 0, strengths: [], weaknesses: [], performanceBreakdown: null };

    // 1. Calculate W/kg for key durations
    // DURATIONS: 5s (Sprint), 1m (Anaerobic), 5m (VO2max), FTP (as best 20m * 0.95)
    const metrics = {
        sprint: (powerCurve.duration_5s || powerCurve.duration_10s || 0) / weight,
        anaerobic: (powerCurve.duration_1m || 0) / weight,
        vo2max: (powerCurve.duration_5m || 0) / weight,
        threshold: (powerCurve.duration_20m * 0.95) / weight
    };

    // 2. Reference Ranges (from screenshots) - used for normalization/comparison
    // These are simplified averages for "Normalizing" the scores to identify RELATIVE strengths
    const ref = {
        sprint: 16,     // Average: 14-17
        anaerobic: 8.5, // Average: 7.5-9.0
        vo2max: 5.8,    // Average: 5.5-6.2
        threshold: 4.5  // Average: 4.2-4.8
    };

    // 3. Calculate Relative Scores (How does this athlete compare to the "average" across these 4 metrics?)
    // This allows us to see where they deviate most from their own "median" performance
    const scores = {
        sprint: metrics.sprint / ref.sprint,
        anaerobic: metrics.anaerobic / ref.anaerobic,
        vo2max: metrics.vo2max / ref.vo2max,
        threshold: metrics.threshold / ref.threshold
    };

    // 4. Identify Strengths & Weaknesses
    // We compare each score to the athlete's own average performance score
    const avgScore = (scores.sprint + scores.anaerobic + scores.vo2max + scores.threshold) / 4;

    const sortedCategories = [
        { label: 'Sprinting', score: scores.sprint, refLabel: 'Neuromuscular Power' },
        { label: 'Attacking/Short Climbs', score: scores.anaerobic, refLabel: 'Anaerobic Capacity' },
        { label: '5-min Power', score: scores.vo2max, refLabel: 'VO2 Max' },
        { label: 'Sustained Power', score: scores.threshold, refLabel: 'Threshold (FTP)' }
    ].sort((a, b) => b.score - a.score);

    const strengths = sortedCategories.slice(0, 1).map(c => c.label);
    const weaknesses = sortedCategories.slice(-1).map(c => c.label);

    // 5. Determine Phenotype and Multiplier Adjustment for FTP
    // Sprinter/Punchy: High sprint/anaerobic RELATIVE to threshold
    // TT/Climber: High threshold RELATIVE to sprint/anaerobic

    let type = 'All-Rounder';
    let adj = 0;

    const anaerobicBias = (scores.sprint + scores.anaerobic) / 2;
    const aerobicBias = (scores.vo2max + scores.threshold) / 2;

    if (anaerobicBias > aerobicBias * 1.1) {
        type = 'Punchy/Sprinter';
        adj = -0.02;
    } else if (aerobicBias > anaerobicBias * 1.1) {
        type = 'Steady/TT';
        adj = 0.02;
    }

    const performance = classifyPerformanceLevel(metrics, sex);

    return {
        type,
        adj,
        strengths,
        weaknesses,
        scores: metrics, // Return raw W/kg for UI if needed
        performanceBreakdown: performance
    };
};

export const calculateEstimatedFtp = (workouts, phenotype = { type: 'Puncheur' }) => {
    if (!workouts || workouts.length === 0) return null;

    let maxLow = 0;
    let maxHigh = 0;
    let maxAvg = 0;

    // Mapping external phenotype types to our bias categories
    const typeMap = {
        'Punchy/Sprinter': 'Sprinter',
        'All-Rounder': 'Puncheur',
        'Steady/TT': 'TTist',
        'Sprinter': 'Sprinter',
        'Puncheur': 'Puncheur',
        'TTist': 'TTist'
    };

    const type = typeMap[phenotype.type] || 'Puncheur';

    // Multiplier & Bias Ranges based on coaching and physiological standards
    // Coggan/Allen (20m: 95%), Carmichael (8m: 90%), MAP Research (5m: ~80%)
    const config = {
        m5: { base: [0.80, 0.82], bias: { Sprinter: [0.05, 0.10], Puncheur: [0.02, 0.06], TTist: [-0.02, 0.02] } },
        m8: { base: [0.90, 0.92], bias: { Sprinter: [0.03, 0.07], Puncheur: [0.01, 0.05], TTist: [-0.01, 0.03] } },
        m20: { base: [0.95, 0.95], bias: { Sprinter: [0.02, 0.05], Puncheur: [-0.01, 0.03], TTist: [-0.03, 0.01] } }
    };

    workouts.forEach(workout => {
        if (!workout.power_curve) return;

        // 5-min Check
        if (workout.power_curve.duration_5m) {
            const p5 = workout.power_curve.duration_5m;
            const b = config.m5.bias[type];
            // True FTP = (Power * Multiplier) / (1 + Bias)
            const low = (p5 * config.m5.base[0]) / (1 + b[1]);
            const high = (p5 * config.m5.base[1]) / (1 + b[0]);
            const avg = (low + high) / 2;
            if (avg > maxAvg) { maxAvg = avg; maxLow = low; maxHigh = high; }
        }

        // 8-min Check (mapping to 8-10m test)
        if (workout.power_curve.duration_8m) {
            const p8 = workout.power_curve.duration_8m;
            const b = config.m8.bias[type];
            const low = (p8 * config.m8.base[0]) / (1 + b[1]);
            const high = (p8 * config.m8.base[1]) / (1 + b[0]);
            const avg = (low + high) / 2;
            if (avg > maxAvg) { maxAvg = avg; maxLow = low; maxHigh = high; }
        }

        // 20-min Check
        if (workout.power_curve.duration_20m) {
            const p20 = workout.power_curve.duration_20m;
            const b = config.m20.bias[type];
            const low = (p20 * config.m20.base[0]) / (1 + b[1]);
            const high = (p20 * config.m20.base[1]) / (1 + b[0]);
            const avg = (low + high) / 2;
            if (avg > maxAvg) { maxAvg = avg; maxLow = low; maxHigh = high; }
        }
    });

    if (maxAvg === 0) return null;

    return {
        avg: Math.round(maxAvg),
        low: Math.round(maxLow),
        high: Math.round(maxHigh)
    };
};

// Monod & Scherrer (2-parameter) Critical Power Model
// Work = CP * Time + W'
export const calculateCriticalPower = (powerCurve) => {
    // Points: [Time (s), Power (W)]
    const p1_duration = 180; // 3m
    const p2_duration = 1200; // 20m

    const p1_power = powerCurve.duration_3m;
    const p2_power = powerCurve.duration_20m;

    if (!p1_power || !p2_power) return null;

    const work1 = p1_power * p1_duration;
    const work2 = p2_power * p2_duration;

    // CP = (Work2 - Work1) / (Time2 - Time1)
    const cp = (work2 - work1) / (p2_duration - p1_duration);

    // W' = Work1 - (CP * Time1)
    const w_prime = work1 - (cp * p1_duration);

    // LoA ≈ −19 to +33 W vs CP
    // This means the estimated CP could be off by this much.
    // We'll return the range [avg - 19, avg + 33]
    return {
        cp: Math.round(cp),
        low: Math.round(cp - 19),
        high: Math.round(cp + 33),
        w_prime: Math.round(w_prime) // Joules
    };
};

export const calculateCriticalHeartRate = (hrCurve) => {
    // Similar to CP, we use 2 points: 3m and 20m max avg HR.
    // Model: TotalBeats = CHR * Time + H'
    // CHR = Slope

    const p1_duration = 180; // 3m
    const p2_duration = 1200; // 20m

    const hr1 = hrCurve.duration_3m;
    const hr2 = hrCurve.duration_20m;

    if (!hr1 || !hr2) return null;

    // Total Beats (analogous to Work in Joules)
    const beats1 = hr1 * (p1_duration / 60); // HR is bpm, so multiply by minutes
    const beats2 = hr2 * (p2_duration / 60);

    // Duration in minutes for slope calc? 
    // Usually standard is: CHR = (Beats2 - Beats1) / (Time2_min - Time1_min) -> bpm
    // Or (Beats2 - Beats1) / (Time2_sec - Time1_sec) -> beats per second * 60 -> bpm

    const t1_min = p1_duration / 60;
    const t2_min = p2_duration / 60;

    const chr = (beats2 - beats1) / (t2_min - t1_min);

    // Intercept (Heart Rate Prime - total beats capacity above CHR)
    const h_prime = beats1 - (chr * t1_min);

    return {
        chr: Math.round(chr),
        h_prime: Math.round(h_prime) // Total beats battery
    };
};

// Standard Normalized Power Algorithm
// 30s rolling average -> x^4 -> Average -> x^(1/4)
export const calculateNormalizedPower = (streams) => {
    if (!streams || streams.length < 30) return 0;

    const rollingAvgs = [];
    let sum = 0;

    // Pre-fill first window ? Standard usually starts having values at t=30s
    // Simple 30s moving average
    for (let i = 0; i < streams.length; i++) {
        const p = streams[i].power || 0;
        sum += p;

        if (i >= 30) {
            sum -= (streams[i - 30].power || 0);
        }

        if (i >= 29) {
            rollingAvgs.push(sum / 30);
        }
    }

    if (rollingAvgs.length === 0) return 0;

    const sumPow4 = rollingAvgs.reduce((acc, val) => acc + Math.pow(val, 4), 0);
    const avgPow4 = sumPow4 / rollingAvgs.length;
    return Math.round(Math.pow(avgPow4, 0.25));
};

// Identify improvements in Power Curve and Efficiency Factor
export const identifyImprovements = (workouts) => {
    if (!workouts || workouts.length === 0) return {};

    const sortedWorkouts = [...workouts].sort((a, b) => new Date(a.date) - new Date(b.date));

    const bests = {
        power: {
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        },
        ef: 0
    };

    const improvementsMap = {}; // workoutId -> [ { label, delta } ]

    sortedWorkouts.forEach(workout => {
        const improvements = [];

        if (workout && workout.power_curve) {
            Object.keys(bests.power).forEach(key => {
                const currentVal = workout.power_curve[key] || 0;
                if (currentVal > bests.power[key] && currentVal > 0) {
                    const delta = bests.power[key] === 0 ? null : currentVal - bests.power[key];
                    bests.power[key] = currentVal;
                    const label = key.replace('duration_', '').replace('m', 'm Power');
                    improvements.push({ label, delta, value: currentVal });
                }
            });
        }

        const np = workout.normalized_power || workout.avg_power;
        const hr = workout.avg_heart_rate;
        const durationMin = workout.total_elapsed_time / 60;
        const ifVal = workout.intensity_factor || (np / (workout.functional_threshold_power || 250));

        if (ifVal && ifVal <= 0.75 && durationMin >= 30 && np && hr > 0) {
            const currentEf = np / hr;
            if (currentEf > bests.ef) {
                const delta = bests.ef === 0 ? null : (currentEf - bests.ef).toFixed(2);
                bests.ef = currentEf;
                improvements.push({ label: 'Aerobic Efficiency', delta, value: currentEf.toFixed(2) });
            }
        }

        if (improvements.length > 0) {
            improvementsMap[workout.id] = improvements;
        }
    });

    return improvementsMap;
};

/**
 * Calculates a session-derived FTP based on cardiac drift during late-workout intervals.
 * Conditions:
 * 1. Workout > 1h AND TSS > 70
 * 2. Interval >= 8 mins long
 * 3. Interval is in the last 40% of the workout
 * 4. HR drift <= 4% in last 3 mins of the interval
 */
export const calculateSessionDerivedFtp = (workouts) => {
    if (!workouts || workouts.length === 0) return null;

    let bestEstimate = null;

    workouts.forEach(workout => {
        // Condition 1: Duration and TSS
        const durationH = (workout.total_elapsed_time || 0) / 3600;
        const tss = workout.training_stress_score || 0;
        if (durationH < 1 || tss <= 70 || !workout.streams || workout.streams.length < 480) return;

        const streams = workout.streams;
        const totalLen = streams.length;
        const last40Start = Math.floor(totalLen * 0.6);

        // Identify candidate intervals in the last 40%
        // We'll look for blocks of 8 mins (480s)
        for (let i = last40Start; i <= totalLen - 480; i += 30) { // Step 30s for efficiency
            const interval = streams.slice(i, i + 480);

            // Basic stability check for the interval (power shouldn't drop too much)
            const avgPower = interval.reduce((acc, p) => acc + (p.power || 0), 0) / interval.length;
            if (avgPower < 100) continue; // Skip very low intensity

            // Cardiac Drift check: Focus specifically on the last 3 mins (180s)
            // Measure increase from start of last 3m to end of last 3m
            const startHrAvg = interval.slice(300, 305).reduce((a, b) => a + (b.heart_rate || 0), 0) / 5;
            const endHrAvg = interval.slice(475, 480).reduce((a, b) => a + (b.heart_rate || 0), 0) / 5;

            if (startHrAvg > 0 && endHrAvg > 0) {
                const drift = (endHrAvg - startHrAvg) / startHrAvg;
                if (drift <= 0.04) {
                    const low = Math.round(avgPower * 0.95);
                    const high = Math.round(avgPower * 1.00);
                    const currentAvg = (low + high) / 2;

                    if (!bestEstimate || currentAvg > (bestEstimate.low + bestEstimate.high) / 2) {
                        bestEstimate = { low, high, avg: Math.round(currentAvg) };
                    }
                }
            }
        }
    });

    return bestEstimate;
};

/**
 * Resolves the "Effective FTP" for a specific workout based on priority:
 * 1. User Imported FTP (from FIT file timestamped setting)
 * 2. Workout Calculated FTP (eFTP from this specific session)
 * 3. Test Calculated FTP (Profile / Recent 20m tests)
 * 4. Critical Power (CP from recent power curve)
 */
export const getEffectiveFtp = (workout, currentProfileFtp, cp) => {
    if (!workout) return currentProfileFtp || 250;

    // 1. Imported / Historical (Stamped)
    if (workout.functional_threshold_power && workout.functional_threshold_power > 0) {
        return workout.functional_threshold_power;
    }

    // 2. Workout Calculated (eFTP single session)
    // Note: This matches "session derived" logic. We can reuse the result if stored, 
    // or quickly re-check if not expensive. For now, assuming it's not pre-stored on the object
    // except if we ran `calculateSessionDerivedFtp` on it. 
    // To strictly follow "Workout Calculated", we might need to run the calc:
    // const sessionFtp = calculateSessionDerivedFtp([workout]); 
    // if (sessionFtp?.avg) return sessionFtp.avg;
    // (Skipping for now to avoid perf hit, assuming "Imported" covers most cases or fallback to Profile)

    // 3. Test Calculated (Profile Setting usually comes from a test)
    if (currentProfileFtp) return currentProfileFtp;

    // 4. CP
    if (cp) return cp;

    return 250; // Default
};

/**
 * Classifies a workout based on repeated efforts/intervals in specific power zones.
 * Falls back to overall Intensity Factor (IF) if high-resolution streams are missing.
 */
export const classifyWorkout = (workout, ftp) => {
    if (!workout || !ftp) return 'Endurance';

    // 1. Fallback: Classification via Intensity Factor (IF)
    const ifVal = workout.intensity_factor || ((workout.normalized_power || workout.avg_power) / ftp);

    // Stricter IF Thresholds for unstructured rides
    const classifyByIF = () => {
        if (!ifVal) return 'Endurance';
        if (ifVal < 0.55) return 'Recovery';
        if (ifVal < 0.80) return 'Endurance';
        if (ifVal < 0.88) return 'Tempo';
        if (ifVal < 1.05) return 'Threshold';
        if (ifVal < 1.20) return 'VO2Max';
        return 'Anaerobic';
    };

    if (!workout.streams || workout.streams.length < 60) {
        return classifyByIF();
    }

    const streams = workout.streams;
    const zones = calculateZones(ftp); // 0=Recovery, 1=Endurance, 2=Tempo, 3=Threshold, 4=VO2, 5=Anaerobic, 6=NM

    // --- Block-Based Interval Detection ---
    // Goal: Identify contiguous "Work" blocks (Power >= Tempo Min).
    // Algorithm:
    // 1. Scan for start of work (Power >= Z3 Min).
    // 2. Continue scanning. Allow "drops" (power < Z3 Min) for up to 30 seconds (e.g. coasting/corners).
    // 3. If drop lasts > 30s, close the interval.
    // 4. Calculate Average Power of the interval.
    // 5. Classify the interval based on Average Power.

    const workThreshold = zones[2].min; // Min Wattage for Tempo (Start of "Work")
    const detectedIntervals = [];

    let currentInterval = null;
    let dropDuration = 0;

    for (let i = 0; i < streams.length; i++) {
        const p = streams[i].power || 0;

        if (currentInterval) {
            // In an interval
            currentInterval.data.push(p);

            if (p < workThreshold) {
                dropDuration++;
            } else {
                dropDuration = 0; // Reset drop counter if we hit power again
            }

            // End Interval Conditions
            if (dropDuration > 30) {
                // Too long below threshold, close it.
                // Exclude the tail of drops? Usually yes, trim the last 30s of low power.
                const validLen = currentInterval.data.length - dropDuration;
                if (validLen > 0) {
                    const finalData = currentInterval.data.slice(0, validLen);
                    detectedIntervals.push({
                        start: currentInterval.start,
                        end: currentInterval.start + validLen,
                        duration: validLen,
                        avgPower: finalData.reduce((a, b) => a + b, 0) / finalData.length
                    });
                }
                currentInterval = null;
                dropDuration = 0;
            }
        } else {
            // Searching for start
            if (p >= workThreshold) {
                currentInterval = {
                    start: i,
                    data: [p]
                };
                dropDuration = 0;
            }
        }
    }
    // Close pending
    if (currentInterval) {
        const validLen = currentInterval.data.length - dropDuration;
        if (validLen > 0) {
            const finalData = currentInterval.data.slice(0, validLen);
            detectedIntervals.push({
                start: currentInterval.start,
                duration: validLen,
                avgPower: finalData.reduce((a, b) => a + b, 0) / finalData.length
            });
        }
    }

    // --- Calculate Raw Time in Zones ---
    let timeInZones = { Recovery: 0, Endurance: 0, Tempo: 0, Threshold: 0, VO2Max: 0, Anaerobic: 0 };

    // We already loop for intervals, but let's do a pure zone distribution check too
    // Optimization: can be done in one pass if we want, but streams are usually < 10k points, so 2nd pass is negligible.
    for (let i = 0; i < streams.length; i++) {
        const p = streams[i].power || 0;
        if (p >= zones[5].min) timeInZones.Anaerobic++;
        else if (p >= zones[4].min) timeInZones.VO2Max++;
        else if (p >= zones[3].min) timeInZones.Threshold++;
        else if (p >= zones[2].min) timeInZones.Tempo++;
        else if (p >= zones[1].min) timeInZones.Endurance++;
        else timeInZones.Recovery++;
    }

    // --- Classify Intervals ---
    let anaerobicCount = 0;
    let vo2Count = 0;
    let thresholdCount = 0; // "Sweet Spot" included here effectively if high enough
    let tempoCount = 0;

    // Time accumulators (based on classified intervals)
    let totalTempoTime = 0;
    let totalThresholdTime = 0;

    detectedIntervals.forEach(iv => {
        const ap = iv.avgPower;
        const dur = iv.duration;

        // Check Zone of Average Power
        let type = 'Endurance';
        // Anaerobic (Z6+): > 120% FTP (approx). Zones[5] is 120-150%
        if (ap >= zones[5].min) {
            if (dur >= 30 && dur <= 180) { // 30s - 3m
                anaerobicCount++;
                type = 'Anaerobic';
            } else if (dur > 180) { // Long blocks at anaerobic power count as VO2Max/Threshold 
                vo2Count++;
                type = 'VO2Max';
            }
        }
        // VO2 Max (Z5): 105-120%
        else if (ap >= zones[4].min) {
            if (dur >= 120 && dur <= 480) { // 2m - 8m
                vo2Count++;
                type = 'VO2Max';
            } else if (dur > 480) { // Very long VO2 effort is Threshold
                thresholdCount++;
                totalThresholdTime += dur;
                type = 'Threshold';
            }
        }
        // Threshold (Z4): 90-105%
        else if (ap >= zones[3].min) {
            if (dur >= 480) { // > 8m
                thresholdCount++;
                totalThresholdTime += dur;
                type = 'Threshold';
            }
        }
        // Tempo (Z3): 75-90%
        else if (ap >= zones[2].min) {
            if (dur >= 900) { // > 15m (relaxed slightly from 20m because Avg Power is stricter)
                tempoCount++;
                totalTempoTime += dur;
                type = 'Tempo';
            }
        }
    });

    // --- Final Classification Logic ---

    // Priority 1: High Intensity
    if (anaerobicCount >= 5) return 'Anaerobic';
    if (vo2Count >= 3) return 'VO2Max';

    // Priority 2: Threshold
    // > 2 intervals OR > 15m time in identified threshold blocks
    // NEW: OR > 20m raw time in Z4 AND Z4 time > Z3 time (to distinguish from hard tempo)
    if (thresholdCount >= 2 || totalThresholdTime >= 900 || (timeInZones.Threshold >= 1200 && timeInZones.Threshold > timeInZones.Tempo)) return 'Threshold';

    // Priority 3: Tempo
    // > 1 interval OR > 30m time in identified tempo blocks
    // NEW: OR > 30m raw time in Z3
    if (tempoCount >= 1 || totalTempoTime >= 1800 || timeInZones.Tempo >= 1800) return 'Tempo';

    // Priority 4: IF Validation check
    // If we found "some" structure but arguably not enough to be a "Workout", check IF
    return classifyByIF();
};

/**
 * Calculates Training DNA: 
 * Finds the "best" week in last 3 months and analyzes the 4-week lead-up.
 */
export const calculateTrainingDNA = (workouts, metrics, ftp) => {
    if (!workouts) return null;
    const safeFtp = ftp || 250; // Default FTP if missing

    const threeMonthsAgo = subDays(new Date(), 90);
    const recentWorkouts = workouts.filter(w => new Date(w.date) >= threeMonthsAgo);

    // 1. Group by weeks (even if empty, we continue to generate trends)
    const weeksMap = {};
    recentWorkouts.forEach(w => {
        const dObj = new Date(w.date);
        if (isNaN(dObj.getTime())) return;
        const date = startOfWeek(dObj);
        const key = date.toISOString();
        if (!weeksMap[key]) weeksMap[key] = [];
        weeksMap[key].push(w);
    });

    // 2. Find Best Week (>= 2 workouts, highest avg feeling)
    let bestWeekKey = null;
    let maxAvgFeeling = -1;

    Object.keys(weeksMap).forEach(key => {
        const weekRides = weeksMap[key];
        if (weekRides.length < 2) return;

        const avgFeeling = weekRides.reduce((acc, r) => acc + (r.feeling_strength || 0), 0) / weekRides.length;
        if (avgFeeling > maxAvgFeeling) {
            maxAvgFeeling = avgFeeling;
            bestWeekKey = key;
        }
    });

    // if (!bestWeekKey) return null; // Continue to calculate trends anyway

    // 3. Analyze 4 weeks prior to bestWeekKey - MOVED DOWN
    let bestWeekStart = null;
    if (bestWeekKey) {
        bestWeekStart = new Date(bestWeekKey);
    }

    // 5. Calculate Long-Term Trends (Last 12 Weeks)
    const twelveWeeksAgo = subDays(new Date(), 84);
    const workouts12w = workouts.filter(w => new Date(w.date) >= twelveWeeksAgo);

    // Generate weekly buckets (1-12)
    const weeklyTrends = [];
    let currentWeekStart = startOfWeek(twelveWeeksAgo);
    const now = new Date();

    while (currentWeekStart <= now) {
        const currentWeekEnd = endOfDay(subDays(addWeeks(currentWeekStart, 1), 1)); // End on Sunday? Or just < next Start

        // Find workouts in this week
        const weekWorkouts = workouts12w.filter(w => {
            const d = new Date(w.date);
            return d >= currentWeekStart && d < addWeeks(currentWeekStart, 1);
        });

        const counts = { Recovery: 0, Endurance: 0, Tempo: 0, Threshold: 0, VO2Max: 0, Anaerobic: 0 };
        weekWorkouts.forEach(w => {
            const label = classifyWorkout(w, safeFtp);
            if (counts[label] !== undefined) counts[label]++;
        });

        weeklyTrends.push({
            weekStart: currentWeekStart.toLocaleDateString(),
            weekLabel: `W${weeklyTrends.length + 1}`,
            ...counts
        });

        currentWeekStart = addWeeks(currentWeekStart, 1);
        if (weeklyTrends.length >= 12) break; // Limit to 12 weeks
    }

    // --- Calculate Trends ---
    const zones = ['Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO2Max', 'Anaerobic'];
    zones.forEach(zone => {
        const values = weeklyTrends.map(w => w[zone] || 0);
        const trendValues = calculateLinearTrend(values);
        weeklyTrends.forEach((w, i) => {
            w[`${zone}Trend`] = trendValues[i];
        });
    });

    const total12wTss = workouts12w.reduce((acc, w) => acc + (w.training_stress_score || 0), 0);
    const total12wSecs = workouts12w.reduce((acc, w) => acc + (w.total_elapsed_time || 0), 0);

    const result = {
        weeklyTrends,
        longTermAverages: {
            tssPerWeek: Math.round(total12wTss / 12),
            hrsPerWeek: (total12wSecs / 3600 / 12).toFixed(1)
        }
    };

    if (bestWeekKey) {
        result.bestWeekStart = bestWeekStart.toLocaleDateString();
        result.avgFeeling = maxAvgFeeling.toFixed(1);
    } else {
        result.insufficientData = true; // Still flag it, but we have trends now
    }

    // 4. Analyze 4 weeks prior to bestWeekKey IF IT EXISTS
    if (bestWeekKey) {
        const lookupEnd = subDays(bestWeekStart, 1);
        const lookupStart = subDays(lookupEnd, 27); // 28 days total

        const priorWorkouts = workouts.filter(w => {
            const d = new Date(w.date);
            return d >= lookupStart && d <= lookupEnd;
        });

        if (priorWorkouts.length >= 10) {
            const priorMetrics = metrics.filter(m => {
                const d = new Date(m.date);
                return d >= lookupStart && d <= lookupEnd;
            });

            // 4. Calculate Averages
            const totalTss = priorWorkouts.reduce((acc, w) => acc + (w.training_stress_score || 0), 0);
            const totalSecs = priorWorkouts.reduce((acc, w) => acc + (w.total_elapsed_time || 0), 0);

            const validSleep = priorMetrics.filter(m => (m.sleepHours || 0) > 0);
            const avgSleep = validSleep.length ? (validSleep.reduce((acc, m) => acc + Number(m.sleepHours), 0) / validSleep.length) : null;

            const validHrv = priorMetrics.filter(m => (m.hrv || 0) > 0);
            const avgHrv = validHrv.length ? (validHrv.reduce((acc, m) => acc + Number(m.hrv), 0) / validHrv.length) : null;

            // Session Types Distribution
            const typeCounts = {
                Recovery: 0,
                Endurance: 0,
                Tempo: 0,
                Threshold: 0,
                VO2Max: 0,
                Anaerobic: 0
            };

            priorWorkouts.forEach(w => {
                const label = classifyWorkout(w, safeFtp);
                if (typeCounts[label] !== undefined) typeCounts[label]++;
            });

            result.winningFormula = {
                tssPerWeek: Math.round(totalTss / 4),
                hrsPerWeek: (totalSecs / 3600 / 4).toFixed(1),
                sleepPerDay: avgSleep ? avgSleep.toFixed(1) : '-',
                hrvPerDay: avgHrv ? Math.round(avgHrv) : '-',
                distribution: {
                    Recovery: (typeCounts.Recovery / 4).toFixed(1),
                    Endurance: (typeCounts.Endurance / 4).toFixed(1),
                    Tempo: (typeCounts.Tempo / 4).toFixed(1),
                    Threshold: (typeCounts.Threshold / 4).toFixed(1),
                    VO2Max: (typeCounts.VO2Max / 4).toFixed(1),
                    Anaerobic: (typeCounts.Anaerobic / 4).toFixed(1)
                }
            };

            // If we have a winning formula, clear the insufficient flag for that section specifically?
            // Or just use winningFormula existence check in UI.
            result.insufficientData = false;
        }
    }

    return result;
};

/**
 * Calculates a linear trend line (y = mx + b) for a given array of numbers.
 * Returns an array of y-values representing the best-fit line.
 */
const calculateLinearTrend = (yValues) => {
    const n = yValues.length;
    if (n === 0) return [];
    if (n === 1) return [yValues[0]];

    const xValues = Array.from({ length: n }, (_, i) => i);

    const sumX = xValues.reduce((a, b) => a + b, 0);
    const sumY = yValues.reduce((a, b) => a + b, 0);
    const sumXY = xValues.reduce((a, i) => a + (i * yValues[i]), 0);
    const sumXX = xValues.reduce((a, i) => a + (i * i), 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return xValues.map(x => slope * x + intercept);
};
