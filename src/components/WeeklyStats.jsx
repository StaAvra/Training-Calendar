import React from 'react';
import { format, startOfWeek, endOfWeek, isSameDay } from 'date-fns';
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

    weekDays.forEach(day => {
        const dayKey = getLocalDayKey(day);
        // Workouts
        const daysWorkouts = workouts.filter(w => getLocalDayKey(w.date) === dayKey);
        daysWorkouts.forEach(w => {
            totalSeconds += w.total_elapsed_time || 0;

            // Get TSS directly or calculate HR-based estimate if missing
            let tss = w.training_stress_score || 0;

            if (!tss && w.avg_heart_rate) {
                const result = calculateTssWithMetadata(w, ftp);
                if (result && result.tss) {
                    tss = result.tss;
                }
            }

            totalTss += tss;
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
