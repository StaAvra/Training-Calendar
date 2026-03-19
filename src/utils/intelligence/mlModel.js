import { subWeeks } from 'date-fns';
import { calculateTimeInZones } from '../analysis.js';

const ZONE_KEYS = ['recovery', 'endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic'];
const ZONE_NAME_TO_KEY = {
    'Active Recovery': 'recovery',
    Endurance: 'endurance',
    Tempo: 'tempo',
    Threshold: 'threshold',
    'VO2 Max': 'vo2max',
    Anaerobic: 'anaerobic'
};

const emptyZoneDistribution = () => ({
    recovery: 0,
    endurance: 0,
    tempo: 0,
    threshold: 0,
    vo2max: 0,
    anaerobic: 0
});

const createEmptyMetrics = () => ({
    avgVol: 0,
    avgTss: 0,
    feeling: 5,
    intensityIndex: 0.5,
    enduranceShare: 0,
    highIntensityShare: 0,
    density: 0,
    successScore: 0
});

const sumZoneDistributions = (accumulator, next) => {
    ZONE_KEYS.forEach((zone) => {
        accumulator[zone] += next[zone] || 0;
    });
    return accumulator;
};

const normalizeZoneDistribution = (zoneDistribution) => {
    const total = Object.values(zoneDistribution).reduce((sum, value) => sum + value, 0);
    if (!total) return emptyZoneDistribution();

    return Object.fromEntries(
        ZONE_KEYS.map((zone) => [zone, zoneDistribution[zone] / total])
    );
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const calculateIntensityIndex = (avgTss, avgVol, zoneDistribution = null) => {
    const tssPerHour = avgVol > 0 ? avgTss / avgVol : 30;
    const tssComponent = clamp((tssPerHour - 20) / 20, 0, 1);

    if (!zoneDistribution) {
        return Math.round(tssComponent * 100) / 100;
    }

    const zoneComponent = clamp(
        (zoneDistribution.threshold || 0) * 0.7 +
        (zoneDistribution.vo2max || 0) * 1.0 +
        (zoneDistribution.anaerobic || 0) * 1.1 +
        (zoneDistribution.tempo || 0) * 0.25,
        0,
        1
    );

    return Math.round(((tssComponent * 0.55) + (zoneComponent * 0.45)) * 100) / 100;
};

const deriveZoneDistributionFromWorkout = (workout, ftp) => {
    const zones = calculateTimeInZones(workout.streams || [], ftp);
    if (!zones.length) return emptyZoneDistribution();

    const distribution = emptyZoneDistribution();
    zones.forEach((zone) => {
        const key = ZONE_NAME_TO_KEY[zone.name];
        if (key) distribution[key] += zone.time || 0;
    });

    return normalizeZoneDistribution(distribution);
};

const collectBlockWorkouts = (workouts, blockEndDate) => {
    const blockStart = subWeeks(blockEndDate, 4);
    return workouts.filter((workout) => {
        const workoutDate = new Date(workout.date);
        return workoutDate >= blockStart && workoutDate <= blockEndDate;
    });
};

const deriveSuccessScore = (adaptation) => {
    const improvementCount = adaptation.improvements?.length || 0;
    const feelingBoost = clamp((adaptation.avgFeeling || 5) / 10, 0.2, 1.2);
    const adaptationTypeBoost = adaptation.type === 'Stress Adaptation' ? 1.0 : 0.8;
    return Math.max(0.25, (improvementCount + 1) * feelingBoost * adaptationTypeBoost);
};

const deriveResponderLabel = (metrics) => {
    if (metrics.highIntensityShare >= 0.32 || metrics.intensityIndex >= 0.62) return 'Intensity';
    if (metrics.enduranceShare >= 0.5 && metrics.intensityIndex <= 0.48) return 'Volume';
    if (Math.abs(metrics.enduranceShare - metrics.highIntensityShare) <= 0.12) return 'Balanced';
    return 'Mixed';
};

const toFeatureVector = (metrics) => ({
    avgVol: metrics.avgVol,
    avgTss: metrics.avgTss,
    feeling: metrics.feeling,
    intensityIndex: metrics.intensityIndex,
    enduranceShare: metrics.enduranceShare,
    highIntensityShare: metrics.highIntensityShare,
    density: metrics.density
});

const calculateNormalizers = (blocks) => {
    const maxima = {
        avgVol: 1,
        avgTss: 1,
        feeling: 10,
        intensityIndex: 1,
        enduranceShare: 1,
        highIntensityShare: 1,
        density: 7
    };

    blocks.forEach((block) => {
        const features = toFeatureVector(block.metrics);
        Object.entries(features).forEach(([key, value]) => {
            maxima[key] = Math.max(maxima[key], value || 0, key === 'feeling' ? 10 : 1);
        });
    });

    return maxima;
};

const distanceBetween = (left, right, normalizers) => {
    const weights = {
        avgVol: 1.0,
        avgTss: 1.1,
        feeling: 0.4,
        intensityIndex: 1.5,
        enduranceShare: 1.3,
        highIntensityShare: 1.3,
        density: 0.6
    };

    return Object.keys(weights).reduce((sum, key) => {
        const normalizer = normalizers[key] || 1;
        const leftValue = (left[key] || 0) / normalizer;
        const rightValue = (right[key] || 0) / normalizer;
        return sum + (Math.abs(leftValue - rightValue) * weights[key]);
    }, 0);
};

const averageFeatureVector = (blocks) => {
    if (!blocks.length) return createEmptyMetrics();

    const totals = {
        avgVol: 0,
        avgTss: 0,
        feeling: 0,
        intensityIndex: 0,
        enduranceShare: 0,
        highIntensityShare: 0,
        density: 0
    };
    let weightTotal = 0;

    blocks.forEach((block) => {
        const weight = block.metrics.successScore || 1;
        const features = toFeatureVector(block.metrics);
        Object.keys(totals).forEach((key) => {
            totals[key] += (features[key] || 0) * weight;
        });
        weightTotal += weight;
    });

    if (!weightTotal) return createEmptyMetrics();

    return Object.fromEntries(
        Object.keys(totals).map((key) => [key, totals[key] / weightTotal])
    );
};

const averageZoneDistribution = (blocks) => {
    if (!blocks.length) return emptyZoneDistribution();
    const totals = emptyZoneDistribution();
    let weightTotal = 0;

    blocks.forEach((block) => {
        const weight = block.metrics.successScore || 1;
        ZONE_KEYS.forEach((zone) => {
            totals[zone] += (block.zoneDistribution[zone] || 0) * weight;
        });
        weightTotal += weight;
    });

    if (!weightTotal) return emptyZoneDistribution();

    return normalizeZoneDistribution(
        Object.fromEntries(ZONE_KEYS.map((zone) => [zone, totals[zone] / weightTotal]))
    );
};

const buildCurrentAthleteState = (analysis, ftp) => {
    const workouts = [...(analysis.workouts || [])]
        .sort((left, right) => new Date(left.date) - new Date(right.date))
        .slice(-16);

    if (!workouts.length) {
        return {
            zoneDistribution: emptyZoneDistribution(),
            metrics: createEmptyMetrics()
        };
    }

    const totalDurationHours = workouts.reduce((sum, workout) => sum + ((workout.total_elapsed_time || 0) / 3600), 0);
    const totalTss = workouts.reduce((sum, workout) => sum + (workout.training_stress_score || workout.calculated_tss || 0), 0);
    const totalFeeling = workouts.reduce((sum, workout) => sum + (workout.feeling_strength || 5), 0);

    const zoneDistribution = normalizeZoneDistribution(
        workouts
            .map((workout) => deriveZoneDistributionFromWorkout(workout, ftp))
            .reduce(sumZoneDistributions, emptyZoneDistribution())
    );

    const metrics = {
        avgVol: workouts.length ? totalDurationHours / Math.max(1, workouts.length / 4) : 0,
        avgTss: workouts.length ? totalTss / Math.max(1, workouts.length / 4) : 0,
        feeling: totalFeeling / workouts.length,
        intensityIndex: calculateIntensityIndex(
            workouts.length ? totalTss / Math.max(1, workouts.length / 4) : 0,
            workouts.length ? totalDurationHours / Math.max(1, workouts.length / 4) : 0,
            zoneDistribution
        ),
        enduranceShare: zoneDistribution.endurance,
        highIntensityShare: zoneDistribution.threshold + zoneDistribution.vo2max + zoneDistribution.anaerobic,
        density: workouts.length / 4,
        successScore: 0
    };

    return { zoneDistribution, metrics };
};

export const buildAdaptationBlocks = (analysis, profile = {}) => {
    const ftp = profile?.ftp || 250;
    const workouts = analysis?.workouts || [];
    const adaptations = analysis?.adaptations || [];

    return adaptations.map((adaptation) => {
        const blockEndDate = new Date(adaptation.date);
        const blockWorkouts = collectBlockWorkouts(workouts, blockEndDate);

        const zoneDistribution = normalizeZoneDistribution(
            blockWorkouts
                .map((workout) => deriveZoneDistributionFromWorkout(workout, ftp))
                .reduce(sumZoneDistributions, emptyZoneDistribution())
        );

        const metrics = {
            avgVol: adaptation.avgVol || 0,
            avgTss: adaptation.avgTss || 0,
            feeling: adaptation.avgFeeling || 5,
            intensityIndex: calculateIntensityIndex(adaptation.avgTss || 0, adaptation.avgVol || 0, zoneDistribution),
            enduranceShare: zoneDistribution.endurance,
            highIntensityShare: zoneDistribution.threshold + zoneDistribution.vo2max + zoneDistribution.anaerobic,
            density: blockWorkouts.length / 5,
            successScore: deriveSuccessScore(adaptation)
        };

        return {
            date: adaptation.date,
            adaptation,
            blockWorkouts,
            zoneDistribution,
            metrics,
            responderLabel: deriveResponderLabel(metrics)
        };
    });
};

const computeResponderProbabilities = (currentFeatures, prototypes, normalizers) => {
    const distances = Object.entries(prototypes).map(([label, prototype]) => {
        const distance = distanceBetween(currentFeatures, prototype.features, normalizers);
        return {
            label,
            distance,
            score: 1 / (distance + 0.1)
        };
    });

    const totalScore = distances.reduce((sum, item) => sum + item.score, 0) || 1;
    const probabilities = Object.fromEntries(
        distances.map((item) => [item.label, Math.round((item.score / totalScore) * 100)])
    );

    const sorted = [...distances].sort((left, right) => right.score - left.score);
    return {
        probabilities,
        predictedLabel: sorted[0]?.label || 'Balanced',
        confidence: Math.min(95, Math.max(35, Math.round(((sorted[0]?.score || 0) / totalScore) * 100)))
    };
};

const buildPrototypes = (blocks) => {
    const groups = blocks.reduce((accumulator, block) => {
        const key = block.responderLabel;
        if (!accumulator[key]) accumulator[key] = [];
        accumulator[key].push(block);
        return accumulator;
    }, {});

    return Object.fromEntries(
        Object.entries(groups).map(([label, labelBlocks]) => [
            label,
            {
                features: averageFeatureVector(labelBlocks),
                zoneDistribution: averageZoneDistribution(labelBlocks),
                sampleCount: labelBlocks.length
            }
        ])
    );
};

const buildResponderTimeline = (blocks, normalizers) => {
    if (blocks.length < 3) return [];

    const timeline = [];
    for (let index = 2; index < blocks.length; index += 1) {
        const windowBlocks = blocks.slice(Math.max(0, index - 2), index + 1);
        const prototypes = buildPrototypes(windowBlocks);
        const currentVector = averageFeatureVector(windowBlocks);
        const { probabilities, predictedLabel, confidence } = computeResponderProbabilities(currentVector, prototypes, normalizers);
        timeline.push({
            blockEnd: windowBlocks[windowBlocks.length - 1].date,
            responderType: predictedLabel,
            confidence,
            probabilities,
            dominantMix: averageZoneDistribution(windowBlocks)
        });
    }

    return timeline;
};

const inferShiftDate = (timeline) => {
    for (let index = 1; index < timeline.length; index += 1) {
        if (timeline[index].responderType !== timeline[index - 1].responderType) {
            return timeline[index].blockEnd;
        }
    }
    return null;
};

const chooseBestHistoricalMix = (blocks, currentState, normalizers) => {
    if (!blocks.length) return emptyZoneDistribution();

    const scoredBlocks = blocks.map((block) => {
        const distance = distanceBetween(currentState.metrics, block.metrics, normalizers);
        const similarity = 1 / (distance + 0.15);
        const score = similarity * (block.metrics.successScore || 1);
        return { block, score };
    }).sort((left, right) => right.score - left.score);

    const topBlocks = scoredBlocks.slice(0, Math.min(5, scoredBlocks.length));
    const totals = emptyZoneDistribution();
    let weightTotal = 0;

    topBlocks.forEach(({ block, score }) => {
        ZONE_KEYS.forEach((zone) => {
            totals[zone] += (block.zoneDistribution[zone] || 0) * score;
        });
        weightTotal += score;
    });

    if (!weightTotal) return averageZoneDistribution(blocks);

    return normalizeZoneDistribution(
        Object.fromEntries(ZONE_KEYS.map((zone) => [zone, totals[zone] / weightTotal]))
    );
};

const computeFeatureImportance = (blocks) => {
    if (!blocks.length) return [];

    const averages = averageFeatureVector(blocks);
    return [
        { name: 'Intensity density', value: averages.highIntensityShare },
        { name: 'Endurance share', value: averages.enduranceShare },
        { name: 'Load per hour', value: averages.intensityIndex },
        { name: 'Weekly volume', value: averages.avgVol / Math.max(1, averages.avgVol) }
    ].sort((left, right) => right.value - left.value);
};

export const trainResponderModel = (analysis, profile = {}) => {
    const blocks = buildAdaptationBlocks(analysis, profile);
    if (blocks.length < 3) {
        return {
            modelType: 'insufficient-data',
            trainedBlockCount: blocks.length,
            responderType: 'Undefined',
            confidence: 0,
            responderProbabilities: {},
            bestHistoricalMix: emptyZoneDistribution(),
            responderTimeline: [],
            hasResponderShift: false,
            lastShiftDate: null,
            currentState: buildCurrentAthleteState(analysis, profile?.ftp || 250),
            featureImportance: []
        };
    }

    const normalizers = calculateNormalizers(blocks);
    const prototypes = buildPrototypes(blocks);
    const currentState = buildCurrentAthleteState(analysis, profile?.ftp || 250);
    const result = computeResponderProbabilities(currentState.metrics, prototypes, normalizers);
    const responderTimeline = buildResponderTimeline(blocks, normalizers);
    const lastShiftDate = inferShiftDate(responderTimeline);

    return {
        modelType: 'prototype-knn-v1',
        trainedBlockCount: blocks.length,
        responderType: result.predictedLabel,
        confidence: result.confidence,
        responderProbabilities: result.probabilities,
        bestHistoricalMix: chooseBestHistoricalMix(blocks, currentState, normalizers),
        responderTimeline,
        hasResponderShift: Boolean(lastShiftDate),
        lastShiftDate,
        currentState,
        featureImportance: computeFeatureImportance(blocks),
        blocks
    };
};

export const describeResponderProfile = (model) => {
    if (!model || model.responderType === 'Undefined') {
        return {
            title: 'Profile Pending',
            message: 'Not enough successful training blocks yet to train a reliable local model for your responder profile.',
            zoneRecommendation: null,
            progressionTip: null
        };
    }

    const probabilities = model.responderProbabilities || {};
    const intensity = probabilities.Intensity || 0;
    const volume = probabilities.Volume || 0;
    const balanced = probabilities.Balanced || 0;

    if (model.responderType === 'Intensity') {
        return {
            title: 'Intensity Responder Identified',
            message: `Your local model classifies you as an intensity-responder with **${model.confidence}% confidence**. Historical blocks with more threshold and VO2 work produced your strongest gains.`,
            zoneRecommendation: `Current responder probabilities: Intensity ${intensity}%, Volume ${volume}%, Balanced ${balanced}%.`,
            progressionTip: 'Use your historical high-intensity response as the anchor, then bend volume only as much as your current availability allows.'
        };
    }

    if (model.responderType === 'Volume') {
        return {
            title: 'Volume Responder Identified',
            message: `Your local model classifies you as a volume-responder with **${model.confidence}% confidence**. Your strongest blocks came from consistent aerobic work, not just denser intensity.`,
            zoneRecommendation: `Current responder probabilities: Volume ${volume}%, Intensity ${intensity}%, Balanced ${balanced}%.`,
            progressionTip: 'Preserve repeatable weekly volume first, then add intensity carefully around that base.'
        };
    }

    if (model.responderType === 'Balanced') {
        return {
            title: 'Balanced Responder',
            message: `Your local model sees a balanced response pattern with **${model.confidence}% confidence**. You adapt from both aerobic load and targeted intensity when they are sequenced well.`,
            zoneRecommendation: `Current responder probabilities: Balanced ${balanced}%, Volume ${volume}%, Intensity ${intensity}%.`,
            progressionTip: 'Keep a mixed structure and use goal demands to decide which side to emphasize in the next block.'
        };
    }

    return {
        title: 'Mixed Responder Profile',
        message: `Your local model detects mixed signals across your history with **${model.confidence}% confidence**. Your best response appears to depend on the phase you were in.`,
        zoneRecommendation: `Current responder probabilities: Volume ${volume}%, Intensity ${intensity}%, Balanced ${balanced}%.`,
        progressionTip: 'Use recent blocks as the stronger signal, especially if the timeline shows a shift in what you respond to now.'
    };
};
