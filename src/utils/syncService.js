const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
const START_TIME_TOLERANCE_MS = 60 * 1000;

const inFlightSyncs = {
    strava: false,
    garmin: false,
    garminMetrics: false,
};

export const normalizeSyncMode = (mode) => {
    if (!mode || mode === 'now') return 'incremental';
    return mode;
};

export const getDefaultBackfillEpochSeconds = () => {
    return Math.floor((Date.now() - SIX_MONTHS_MS) / 1000);
};

export const getDefaultBackfillTimestampMs = () => {
    return Date.now() - SIX_MONTHS_MS;
};

export const beginSync = (provider) => {
    if (!provider || !(provider in inFlightSyncs)) return false;
    if (inFlightSyncs[provider]) return false;
    inFlightSyncs[provider] = true;
    return true;
};

export const endSync = (provider) => {
    if (!provider || !(provider in inFlightSyncs)) return;
    inFlightSyncs[provider] = false;
};

const getStartMs = (workoutOrActivity) => {
    if (!workoutOrActivity) return NaN;
    return new Date(workoutOrActivity.start_time || workoutOrActivity.start_date || workoutOrActivity.date).getTime();
};

export const isSameStartTime = (a, b) => {
    const t1 = getStartMs(a);
    const t2 = getStartMs(b);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return false;
    return Math.abs(t1 - t2) < START_TIME_TOLERANCE_MS;
};

export const isDuplicateWorkout = (existingWorkout, incomingWorkout) => {
    if (!existingWorkout || !incomingWorkout) return false;

    if (incomingWorkout.strava_id && existingWorkout.strava_id === incomingWorkout.strava_id) {
        return true;
    }

    if (incomingWorkout.garmin_id && existingWorkout.garmin_id === incomingWorkout.garmin_id) {
        return true;
    }

    return isSameStartTime(existingWorkout, incomingWorkout);
};

export const getStravaSyncWindow = ({ mode, fromDate, toDate, lastSyncEpoch, incrementalFallbackEpoch }) => {
    const normalizedMode = normalizeSyncMode(mode);
    let afterEpoch;
    let beforeEpoch;

    if (normalizedMode === 'incremental') {
        afterEpoch = lastSyncEpoch || incrementalFallbackEpoch || getDefaultBackfillEpochSeconds();
        return { afterEpoch, beforeEpoch };
    }

    if (normalizedMode === 'all') {
        afterEpoch = getDefaultBackfillEpochSeconds();
        return { afterEpoch, beforeEpoch };
    }

    if (normalizedMode === 'custom') {
        afterEpoch = fromDate ? Math.floor(new Date(fromDate).getTime() / 1000) : getDefaultBackfillEpochSeconds();
        if (toDate) {
            const to = new Date(toDate);
            to.setHours(23, 59, 59, 999);
            beforeEpoch = Math.floor(to.getTime() / 1000);
        }
        return { afterEpoch, beforeEpoch };
    }

    if (normalizedMode === 'fromDate') {
        afterEpoch = fromDate ? Math.floor(new Date(fromDate).getTime() / 1000) : getDefaultBackfillEpochSeconds();
        return { afterEpoch, beforeEpoch };
    }

    return {
        afterEpoch: lastSyncEpoch || incrementalFallbackEpoch || getDefaultBackfillEpochSeconds(),
        beforeEpoch,
    };
};

export const getGarminSyncWindow = ({ mode, fromDate, toDate, lastSyncEpoch, incrementalFallbackMs }) => {
    const normalizedMode = normalizeSyncMode(mode);
    let fromTs;
    let toTs;

    if (normalizedMode === 'incremental') {
        const fallbackMs = Number.isFinite(incrementalFallbackMs) ? incrementalFallbackMs : getDefaultBackfillTimestampMs();
        fromTs = lastSyncEpoch ? lastSyncEpoch * 1000 : fallbackMs;
        return { fromTs, toTs };
    }

    if (normalizedMode === 'all') {
        fromTs = getDefaultBackfillTimestampMs();
        return { fromTs, toTs };
    }

    if (normalizedMode === 'custom') {
        if (fromDate) fromTs = new Date(`${fromDate}T00:00:00`).getTime();
        if (toDate) toTs = new Date(`${toDate}T23:59:59`).getTime();
        return { fromTs, toTs };
    }

    if (normalizedMode === 'fromDate') {
        if (fromDate) fromTs = new Date(`${fromDate}T00:00:00`).getTime();
        return { fromTs, toTs };
    }

    fromTs = lastSyncEpoch ? lastSyncEpoch * 1000 : getDefaultBackfillTimestampMs();
    return { fromTs, toTs };
};
