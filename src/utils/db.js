import { openDB } from 'idb';

const DB_NAME = 'velotrain-db';
const DB_VERSION = 4;

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
        return database.add('workouts', workout);
    },

    async updateWorkout(id, data) {
        const database = await initDB();
        const workout = await database.get('workouts', id);
        return database.put('workouts', { ...workout, ...data });
    },

    async deleteWorkout(id) {
        const database = await initDB();
        return database.delete('workouts', id);
    },

    async getWorkouts(userId) {
        const database = await initDB();
        if (userId) {
            return database.getAllFromIndex('workouts', 'userId', userId);
        }
        return database.getAll('workouts');
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
        return database.put('metrics', { ...data, userId, date: dateKey, id });
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
    }
};
