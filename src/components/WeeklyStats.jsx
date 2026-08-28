import React from 'react';
import { Clock, Moon, Heart, Activity } from 'lucide-react';
import { getLocalDayKey } from '../utils/db';
import { calculateTssWithMetadata } from '../utils/analysis';
import styles from './WeeklyStats.module.css';

const WeeklyStats = ({ weekIndex, weekDays, workouts, metrics, currentUser }) => {
    let totalSeconds = 0;
    let totalTss = 0;
    let totalSleep = 0;
    let totalSleepQuality = 0;
    let totalHrv = 0;
    let sleepCount = 0;
    let sleepQualityCount = 0;
    let hrvCount = 0;

    const ftp = currentUser?.profile?.ftp || 250;
    const nowTs = Date.now();

    const getCompletionStatus = (workout) => {
        if (!workout) return 'planned';
        if (workout.completion_status) return workout.completion_status;
        if (workout.completed === true) return 'completed';

        const actual = Number(workout.actual_tss);
        if (Number.isFinite(actual) && actual > 0) return 'completed';

        const ts = new Date(workout.date || workout.start_time).getTime();
        const isFuture = Number.isFinite(ts) && ts > nowTs;
        if (workout.planned === true || workout.plan_source === 'four_week' || isFuture) return 'planned';

        return 'completed';
    };

    const resolveWorkoutTss = (workout) => {
        if (getCompletionStatus(workout) !== 'completed') return 0;

        const actual = Number(workout.actual_tss);
        if (Number.isFinite(actual) && actual > 0) return actual;

        const recalculated = Number(calculateTssWithMetadata(workout, ftp)?.tss);
        if (Number.isFinite(recalculated) && recalculated > 0) return recalculated;

        const stored = Number(workout.training_stress_score);
        if (Number.isFinite(stored) && stored > 0) return stored;

        return 0;
    };

    weekDays.forEach(day => {
        const dayKey = getLocalDayKey(day);
        // Workouts
        const daysWorkouts = workouts.filter(w => getLocalDayKey(w.date) === dayKey);
        daysWorkouts.forEach(w => {
            if (getCompletionStatus(w) !== 'completed') return;
            totalSeconds += w.total_elapsed_time || 0;
            totalTss += resolveWorkoutTss(w);
        });

        // Metrics
        const dayMetric = metrics.find(m => m.date === dayKey);
        if (dayMetric) {
            if (dayMetric.sleepHours) {
                totalSleep += dayMetric.sleepHours;
                sleepCount++;
            }
            if (dayMetric.sleepQuality) {
                totalSleepQuality += dayMetric.sleepQuality;
                sleepQualityCount++;
            }
            if (dayMetric.hrv) {
                totalHrv += dayMetric.hrv;
                hrvCount++;
            }
        }
    });

    const stats = {
        duration: (totalSeconds / 3600).toFixed(1),
        tss: Math.round(totalTss),
        avgSleep: sleepCount > 0 ? (totalSleep / sleepCount).toFixed(1) : '-',
        avgSleepQuality: sleepQualityCount > 0 ? Math.round(totalSleepQuality / sleepQualityCount) : '-',
        avgHrv: hrvCount > 0 ? Math.round(totalHrv / hrvCount) : '-',
    };

    return (
        <div className={styles.weekCard}>
            <div className={styles.weekHeader}>
                <span>Week {weekIndex + 1}</span>
            </div>

            <div className={styles.statsGrid}>
                <div className={styles.statItem} title="Total Duration">
                    <Clock size={14} className={styles.icon} />
                    <span>{stats.duration}h</span>
                </div>
                <div className={styles.statItem} title="Total TSS">
                    <Activity size={14} className={styles.icon} />
                    <span>{stats.tss} TSS</span>
                </div>
                <div className={styles.statItem} title="Avg Sleep Duration">
                    <Moon size={14} className={styles.icon} />
                    <span>{stats.avgSleep}h</span>
                </div>
                <div className={styles.statItem} title="Avg Sleep Quality">
                    <Activity size={14} className={styles.icon} />
                    <span>{stats.avgSleepQuality}%</span>
                </div>
                <div className={styles.statItem} title="Avg HRV">
                    <Heart size={14} className={styles.icon} />
                    <span>{stats.avgHrv}ms</span>
                </div>
            </div>
        </div>
    );
};

export default WeeklyStats;
