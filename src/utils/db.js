import { openDB } from 'idb';

const DB_NAME = 'velotrain-db';
const DB_VERSION = 5;

// Stable local day key (YYYY-MM-DD)
export const getLocalDayKey = (date) => {
    try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return null;
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        return null;
    }
};

const emitTrainingDataUpdated = (detail = {}) => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('training-data-updated', { detail }));
};

const workoutRichnessScore = (workout) => {
    if (!workout) return 0;
    let score = 0;
    if (Array.isArray(workout.streams) && workout.streams.length > 0) score += 10;
    if (workout.power_curve) score += 4;
    if (workout.heart_rate_curve) score += 4;
    if (Number(workout.avg_power || 0) > 0) score += 2;
    if (Number(workout.avg_heart_rate || 0) > 0) score += 2;
    if (Number(workout.total_distance || 0) > 0) score += 1;
    if (Number(workout.total_elapsed_time || 0) > 0) score += 1;
    return score;
};

const chooseWorkoutSurvivor = (a, b) => {
    const scoreA = workoutRichnessScore(a);
    const scoreB = workoutRichnessScore(b);
    if (scoreA !== scoreB) return scoreA > scoreB ? a : b;

    const importedA = new Date(a?.imported_at || 0).getTime();
    const importedB = new Date(b?.imported_at || 0).getTime();
    if (Number.isFinite(importedA) && Number.isFinite(importedB) && importedA !== importedB) {
        return importedA > importedB ? a : b;
    }

    return (a?.id || 0) <= (b?.id || 0) ? a : b;
};

const mergeWorkoutDetails = (target, source) => {
    const merged = { ...target };
    Object.keys(source || {}).forEach((key) => {
        if (['id', 'userId', 'created_at'].includes(key)) return;
        const sourceValue = source[key];
        const targetValue = merged[key];

        if (Array.isArray(targetValue) && targetValue.length === 0 && Array.isArray(sourceValue) && sourceValue.length > 0) {
            merged[key] = sourceValue;
            return;
        }

        const targetMissing = targetValue === null || targetValue === undefined || targetValue === '';
        const sourcePresent = sourceValue !== null && sourceValue !== undefined && sourceValue !== '';
        if (targetMissing && sourcePresent) {
            merged[key] = sourceValue;
        }
    });
    return merged;
};

export const initDB = async () => {
    return openDB(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion, newVersion, transaction) {
            // Users Store
            if (!db.objectStoreNames.contains('users')) {
                db.createObjectStore('users', { keyPath: 'id', autoIncrement: true });
            }

            // Workouts Store
            if (!db.objectStoreNames.contains('workouts')) {
                const workoutStore = db.createObjectStore('workouts', { keyPath: 'id', autoIncrement: true });
                workoutStore.createIndex('date', 'date');
                workoutStore.createIndex('userId', 'userId');
            } else {
                const workoutStore = transaction.objectStore('workouts');
                if (!workoutStore.indexNames.contains('userId')) {
                    workoutStore.createIndex('userId', 'userId');
                }
            }

            // User Settings / Profile
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings');
            }

            // Daily Metrics
            if (!db.objectStoreNames.contains('metrics')) {
                const metricsStore = db.createObjectStore('metrics', { keyPath: 'id' });
                metricsStore.createIndex('userId', 'userId');
                metricsStore.createIndex('date', 'date');
            }

            // Planning Constraints / Events
            if (!db.objectStoreNames.contains('constraints')) {
                const constraintsStore = db.createObjectStore('constraints', { keyPath: 'id', autoIncrement: true });
                constraintsStore.createIndex('userId', 'userId');
                constraintsStore.createIndex('startDate', 'startDate');
                constraintsStore.createIndex('endDate', 'endDate');
                constraintsStore.createIndex('type', 'type');
            } else {
                const constraintsStore = transaction.objectStore('constraints');
                if (!constraintsStore.indexNames.contains('userId')) constraintsStore.createIndex('userId', 'userId');
                if (!constraintsStore.indexNames.contains('startDate')) constraintsStore.createIndex('startDate', 'startDate');
                if (!constraintsStore.indexNames.contains('endDate')) constraintsStore.createIndex('endDate', 'endDate');
                if (!constraintsStore.indexNames.contains('type')) constraintsStore.createIndex('type', 'type');
            }
        },
    });
};

export const db = {
    async getUsers() {
        const database = await initDB();
        return database.getAll('users');
    },

    async addUser(name) {
        const database = await initDB();
        const newUser = {
            name,
            joinedAt: new Date().toISOString(),
            profile: {
                ftp: 250,
                weight: 70,
                maxHr: 190,
                lthr: 170
            }
        };
        return database.add('users', newUser);
    },

    async updateUser(id, data) {
        const database = await initDB();
        const user = await database.get('users', id);
        return database.put('users', { ...user, ...data });
    },

    async addWorkout(workout) {
        const database = await initDB();
        const id = await database.add('workouts', workout);
        emitTrainingDataUpdated({ entity: 'workout', action: 'add', id, userId: workout?.userId });
        return id;
    },

    async upsertWorkout(workout) {
        const database = await initDB();
        const allWorkouts = await database.getAll('workouts');
        const userId = Number(workout?.userId);
        const incomingStart = new Date(workout?.start_time || workout?.date).getTime();

        const match = allWorkouts.find((w) => {
            if (Number(w?.userId) !== userId) return false;

            if (workout?.strava_id && w?.strava_id === workout.strava_id) return true;
            if (workout?.garmin_id && w?.garmin_id === workout.garmin_id) return true;

            const existingStart = new Date(w?.start_time || w?.date).getTime();
            if (!Number.isFinite(existingStart) || !Number.isFinite(incomingStart)) return false;

            if (Math.abs(existingStart - incomingStart) >= 60000) return false;

            const incomingDistance = Number(workout?.total_distance || 0);
            const existingDistance = Number(w?.total_distance || 0);
            if (incomingDistance > 0 && existingDistance > 0) {
                return Math.abs(existingDistance - incomingDistance) <= 50;
            }

            return true;
        });

        if (!match) {
            const id = await database.add('workouts', workout);
            emitTrainingDataUpdated({ entity: 'workout', action: 'add', id, userId: workout?.userId });
            return { id, inserted: true, updated: false };
        }

        const merged = {
            ...match,
            ...workout,
            id: match.id,
            userId: match.userId,
        };

        await database.put('workouts', merged);
        emitTrainingDataUpdated({ entity: 'workout', action: 'update', id: match.id, userId: match?.userId });
        return { id: match.id, inserted: false, updated: true };
    },

    async updateWorkout(id, data) {
        const database = await initDB();
        const workout = await database.get('workouts', id);
        const result = await database.put('workouts', { ...workout, ...data });
        emitTrainingDataUpdated({ entity: 'workout', action: 'update', id, userId: workout?.userId });
        return result;
    },

    async deleteWorkout(id) {
        const database = await initDB();
        const existing = await database.get('workouts', id);
        const result = await database.delete('workouts', id);
        emitTrainingDataUpdated({ entity: 'workout', action: 'delete', id, userId: existing?.userId });
        return result;
    },

    async getWorkouts(userId) {
        const database = await initDB();
        if (userId) {
            return database.getAllFromIndex('workouts', 'userId', userId);
        }
        return database.getAll('workouts');
    },

    async cleanupDuplicateWorkouts(userId) {
        const database = await initDB();
        const workouts = await database.getAllFromIndex('workouts', 'userId', userId);
        const toDelete = new Set();
        const mergedById = new Map();

        const processGroup = (group) => {
            if (!Array.isArray(group) || group.length <= 1) return;

            let survivor = group[0];
            for (let i = 1; i < group.length; i++) {
                survivor = chooseWorkoutSurvivor(survivor, group[i]);
            }

            let merged = { ...(mergedById.get(survivor.id) || survivor) };
            group.forEach((w) => {
                if (w.id === survivor.id) return;
                toDelete.add(w.id);
                merged = mergeWorkoutDetails(merged, w);
            });

            mergedById.set(survivor.id, merged);
        };

        const byExternalId = new Map();
        workouts.forEach((w) => {
            if (w.strava_id) {
                const key = `strava:${w.strava_id}`;
                if (!byExternalId.has(key)) byExternalId.set(key, []);
                byExternalId.get(key).push(w);
            }
            if (w.garmin_id) {
                const key = `garmin:${w.garmin_id}`;
                if (!byExternalId.has(key)) byExternalId.set(key, []);
                byExternalId.get(key).push(w);
            }
        });
        byExternalId.forEach(processGroup);

        const activeWorkouts = workouts.filter((w) => !toDelete.has(w.id));
        const used = new Set();
        for (let i = 0; i < activeWorkouts.length; i++) {
            const base = activeWorkouts[i];
            if (used.has(base.id)) continue;

            const baseStart = new Date(base.start_time || base.date).getTime();
            if (!Number.isFinite(baseStart)) continue;

            const group = [base];
            used.add(base.id);

            for (let j = i + 1; j < activeWorkouts.length; j++) {
                const candidate = activeWorkouts[j];
                if (used.has(candidate.id)) continue;

                const candStart = new Date(candidate.start_time || candidate.date).getTime();
                if (!Number.isFinite(candStart) || Math.abs(candStart - baseStart) >= 60000) continue;

                const baseDistance = Number(base.total_distance || 0);
                const candDistance = Number(candidate.total_distance || 0);
                if (baseDistance > 0 && candDistance > 0 && Math.abs(baseDistance - candDistance) > 500) continue;

                const baseDuration = Number(base.total_elapsed_time || 0);
                const candDuration = Number(candidate.total_elapsed_time || 0);
                if (baseDuration > 0 && candDuration > 0 && Math.abs(baseDuration - candDuration) > 120) continue;

                group.push(candidate);
                used.add(candidate.id);
            }

            processGroup(group);
        }

        for (const [id, mergedWorkout] of mergedById.entries()) {
            await database.put('workouts', mergedWorkout);
            emitTrainingDataUpdated({ entity: 'workout', action: 'update', id, userId });
        }

        for (const id of toDelete) {
            await database.delete('workouts', id);
            emitTrainingDataUpdated({ entity: 'workout', action: 'delete', id, userId });
        }

        return {
            scanned: workouts.length,
            updated: mergedById.size,
            removed: toDelete.size,
        };
    },

    async saveSettings(key, value) {
        const database = await initDB();
        return database.put('settings', value, key);
    },

    async getSettings(key) {
        const database = await initDB();
        return database.get('settings', key);
    },

    async saveMetric(userId, date, data) {
        const database = await initDB();
        const dateKey = getLocalDayKey(date);
        if (!dateKey) throw new Error("Invalid date provided to saveMetric");
        const id = `${userId}_${dateKey}`;
        const result = await database.put('metrics', { ...data, userId, date: dateKey, id });
        emitTrainingDataUpdated({ entity: 'metric', action: 'upsert', id, userId });
        return result;
    },

    async getMetric(userId, date) {
        const database = await initDB();
        const dateKey = getLocalDayKey(date);
        if (!dateKey) return null;
        const id = `${userId}_${dateKey}`;
        let metric = await database.get('metrics', id);

        // Robust fallback for old formats
        if (!metric) {
            const all = await database.getAll('metrics');
            const found = all.find(m => m.userId === userId && getLocalDayKey(m.date) === dateKey);
            if (found) {
                console.log("Found legacy metric during getMetric, migrating...");
                const { id: oldId, ...rest } = found;
                metric = { ...rest, id, date: dateKey, userId };
                await database.put('metrics', metric);
                if (oldId !== id) await database.delete('metrics', oldId);
            }
        }
        return metric;
    },

    async getMetrics(userId) {
        const database = await initDB();
        const all = await database.getAll('metrics');
        const userMetrics = all.filter(m => m.userId === userId);

        let hasChanges = false;
        const result = [];

        for (const metric of userMetrics) {
            const dateKey = getLocalDayKey(metric.date);
            if (!dateKey) {
                result.push(metric);
                continue;
            }

            const expectedId = `${userId}_${dateKey}`;
            if (metric.id !== expectedId || metric.date !== dateKey) {
                console.log("Migrating metric format:", metric.id, "->", expectedId);
                const { id: oldId, ...rest } = metric;
                const updated = { ...rest, id: expectedId, date: dateKey, userId };
                await database.put('metrics', updated);
                if (oldId !== expectedId) await database.delete('metrics', oldId);
                result.push(updated);
                hasChanges = true;
            } else {
                result.push(metric);
            }
        }

        return result;
    },

    async getConstraints(userId) {
        const database = await initDB();
        const all = await database.getAll('constraints');
        if (!userId) return all;
        return all.filter(c => Number(c.userId) === Number(userId));
    },

    async addConstraint(constraint) {
        const database = await initDB();
        const payload = {
            ...constraint,
            createdAt: constraint?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const id = await database.add('constraints', payload);
        emitTrainingDataUpdated({ entity: 'constraint', action: 'add', id, userId: payload?.userId });
        return id;
    },

    async updateConstraint(id, data) {
        const database = await initDB();
        const existing = await database.get('constraints', id);
        if (!existing) return null;
        const payload = { ...existing, ...data, updatedAt: new Date().toISOString() };
        const result = await database.put('constraints', payload);
        emitTrainingDataUpdated({ entity: 'constraint', action: 'update', id, userId: payload?.userId });
        return result;
    },

    async deleteConstraint(id) {
        const database = await initDB();
        const existing = await database.get('constraints', id);
        const result = await database.delete('constraints', id);
        emitTrainingDataUpdated({ entity: 'constraint', action: 'delete', id, userId: existing?.userId });
        return result;
    }
};
