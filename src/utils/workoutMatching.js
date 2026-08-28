import { getLocalDayKey } from './db.js';

const getWorkoutTs = (workout) => {
    const ts = new Date(workout?.start_time || workout?.date).getTime();
    return Number.isFinite(ts) ? ts : null;
};

const getCompletionStatus = (workout) => {
    if (!workout) return 'completed';
    if (workout.completion_status) return workout.completion_status;
    if (workout.completed === true) return 'completed';
    if (workout.planned === true || workout.plan_source === 'four_week') return 'planned';
    return 'completed';
};

const isPlannedCandidate = (workout) => {
    if (!workout) return false;
    const status = getCompletionStatus(workout);
    const isPlanned = workout.planned === true || workout.plan_source === 'four_week' || status === 'planned';
    return isPlanned && status !== 'completed';
};

/**
 * Finds the best planned workout to be fulfilled by an imported activity.
 * Matching is constrained to the same local calendar day.
 */
export const findPlannedWorkoutMatch = (existingWorkouts, incomingStartTime) => {
    if (!Array.isArray(existingWorkouts) || !incomingStartTime) return null;

    const incomingTs = new Date(incomingStartTime).getTime();
    if (!Number.isFinite(incomingTs)) return null;

    const incomingDay = getLocalDayKey(incomingStartTime);
    if (!incomingDay) return null;

    const candidates = existingWorkouts
        .filter(w => isPlannedCandidate(w) && getLocalDayKey(w.date || w.start_time) === incomingDay)
        .sort((a, b) => {
            const aTs = getWorkoutTs(a) ?? incomingTs;
            const bTs = getWorkoutTs(b) ?? incomingTs;
            return Math.abs(aTs - incomingTs) - Math.abs(bTs - incomingTs);
        });

    return candidates[0] || null;
};
