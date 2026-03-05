import React from 'react';
import { format, startOfWeek, endOfWeek, isSameDay } from 'date-fns';
import { Clock, Moon, Heart, Activity } from 'lucide-react';
import { getLocalDayKey } from '../utils/db';
import { calculateTssWithMetadata } from '../utils/analysis';
import styles from './WeeklyStats.module.css';

const WeeklyStats = ({ calendarDays, workouts, metrics, currentUser }) => {
    // 1. Group days into weeks
    const weeks = [];
    for (let i = 0; i < calendarDays.length; i += 7) {
        weeks.push(calendarDays.slice(i, i + 7));
    }

    const getStatsForWeek = (weekDays) => {
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

        return {
            duration: (totalSeconds / 3600).toFixed(1),
            tss: Math.round(totalTss),
            avgSleep: sleepCount > 0 ? (totalSleep / sleepCount).toFixed(1) : '-',
            avgSleepQuality: sleepQualityCount > 0 ? Math.round(totalSleepQuality / sleepQualityCount) : '-',
            avgHrv: hrvCount > 0 ? Math.round(totalHrv / hrvCount) : '-',
        };
    };

    return (
        <div className={styles.container}>
            <h3 className={styles.title}>Weekly Summary</h3>
            <div className={styles.list}>
                {weeks.map((week, index) => {
                    const stats = getStatsForWeek(week);
                    const startStr = format(week[0], 'MMM d');
                    const endStr = format(week[6], 'MMM d');

                    return (
                        <div key={index} className={styles.weekCard}>
                            <div className={styles.weekHeader}>
                                <span>Week {index + 1}</span>
                                <span className="text-muted" style={{ fontSize: '0.8rem' }}>{startStr} - {endStr}</span>
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
                    )
                })}
            </div>
        </div>
    );
};

export default WeeklyStats;
