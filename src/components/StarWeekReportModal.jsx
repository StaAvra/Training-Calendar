import React, { useMemo } from 'react';
import { subDays, isWithinInterval, startOfDay, endOfDay, max } from 'date-fns';
import { X, Trophy, Activity, Moon, Heart, AlertTriangle, Zap } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { calculateTimeInZones, calculateCriticalPower, calculateEstimatedFtp, classifyWorkout } from '../utils/analysis';
import { getLocalDayKey } from '../utils/db';
import styles from './StarWeekReportModal.module.css';

const zoneColors = [
    '#888888', // Z1
    '#3b82f6', // Z2
    '#22c55e', // Z3
    '#eab308', // Z4
    '#f97316', // Z5
    '#ef4444', // Z6
    '#a855f7'  // Z7
];
const zoneNames = ['Rec', 'End', 'Tmp', 'Thr', 'VO2', 'Ana', 'Neu'];

const getDateKey = (date) => {
    try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return 'invalid';
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        return 'invalid';
    }
};

const StarWeekReportModal = ({ isOpen, onClose, endDate, workouts, metrics, currentUser }) => {
    if (!isOpen || !endDate) return null;

    const ftp = currentUser?.profile?.ftp || 250;

    // Stable Date Calculations
    const { starStart, starEnd, historyStart, historyEnd } = useMemo(() => {
        try {
            const sEnd = endOfDay(new Date(endDate));
            const sStart = startOfDay(subDays(sEnd, 6));
            const hEnd = endOfDay(subDays(sStart, 1));
            const hStart = startOfDay(subDays(hEnd, 41));
            return { starStart: sStart, starEnd: sEnd, historyStart: hStart, historyEnd: hEnd };
        } catch (e) {
            console.error("Error calculating dates", e);
            const now = new Date();
            return { starStart: now, starEnd: now, historyStart: now, historyEnd: now };
        }
    }, [endDate]);

    // Filter Data
    const starWorkouts = useMemo(() => {
        try {
            const sKey = getLocalDayKey(starStart);
            const eKey = getLocalDayKey(starEnd);
            return (workouts || []).filter(w => {
                const wkKey = getLocalDayKey(w.date);
                return wkKey && wkKey >= sKey && wkKey <= eKey;
            }).sort((a, b) => new Date(a.date) - new Date(b.date));
        } catch (e) {
            console.error("Error filtering star workouts", e);
            return [];
        }
    }, [workouts, starStart, starEnd]);

    const historyData = useMemo(() => {
        try {
            const hSKey = getLocalDayKey(historyStart);
            const hEKey = getLocalDayKey(historyEnd);

            const relevantWorkouts = (workouts || []).filter(w => {
                const wkKey = getLocalDayKey(w.date);
                return wkKey && wkKey >= hSKey && wkKey <= hEKey;
            });

            const relevantMetrics = (metrics || []).filter(m => {
                const mtKey = getLocalDayKey(m.date);
                return mtKey && mtKey >= hSKey && mtKey <= hEKey;
            });

            return { workouts: relevantWorkouts, metrics: relevantMetrics };
        } catch (e) {
            console.error("Error filtering history data", e);
            return { workouts: [], metrics: [] };
        }
    }, [workouts, metrics, historyStart, historyEnd]);

    // --- Section 1: Star Period Analytics ---
    const starWorkoutsData = useMemo(() => {
        if (!starWorkouts.length) return [];
        try {
            return starWorkouts.map(w => {
                const zones = calculateTimeInZones(w.streams || [], ftp);
                const totalSec = zones.reduce((acc, z) => acc + (z.time || 0), 0);

                const breakdown = zones.map((z, i) => ({
                    name: zoneNames[i],
                    color: z.color,
                    percent: totalSec > 0 ? Math.round((z.time / totalSec) * 100) : 0,
                    minutes: Math.round(z.time / 60)
                })).filter(z => z.percent > 0);

                return {
                    id: w.id || Math.random().toString(),
                    title: w.title || 'Ride',
                    date: new Date(w.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                    totalMinutes: Math.round(totalSec / 60),
                    breakdown
                };
            });
        } catch (e) {
            console.error("Error calculating star workout data", e);
            return [];
        }
    }, [starWorkouts, ftp]);

    // --- Section 3: Performance Comparison (Rolling 6-Week Windows) ---
    const performanceComparison = useMemo(() => {
        try {
            const getMetricsForPeriod = (windowStart, windowEnd) => {
                const sKey = getLocalDayKey(windowStart);
                const eKey = getLocalDayKey(windowEnd);

                const periodWorkouts = (workouts || []).filter(w => {
                    const wkKey = getLocalDayKey(w.date);
                    return wkKey && wkKey >= sKey && wkKey <= eKey;
                });

                if (!periodWorkouts.length) return { ftp: null, cp: null, ae: null };

                // 1. Critical Power (CP) - Best 3m and 20m from period
                const curveBests = { duration_3m: 0, duration_20m: 0 };
                periodWorkouts.forEach(w => {
                    if (w.power_curve) {
                        if (w.power_curve.duration_3m > curveBests.duration_3m) curveBests.duration_3m = w.power_curve.duration_3m;
                        if (w.power_curve.duration_20m > curveBests.duration_20m) curveBests.duration_20m = w.power_curve.duration_20m;
                    }
                });
                const cp = calculateCriticalPower(curveBests)?.cp || null;

                // 2. FTP - Estimated from rides in period
                const ftpEst = calculateEstimatedFtp(periodWorkouts, { type: 'All-Rounder' })?.avg || null;

                // 3. Aerobic Efficiency (AE) - Max from qualifying rides in period
                const qualifyingAE = periodWorkouts
                    .filter(w => (w.intensity_factor || (w.avg_power / ftp)) < 0.75 && (w.total_elapsed_time / 60) > 30 && w.avg_heart_rate > 0)
                    .map(w => (w.normalized_power || w.avg_power) / w.avg_heart_rate);

                const ae = qualifyingAE.length > 0
                    ? Math.max(...qualifyingAE)
                    : null;

                return { ftp: ftpEst, cp, ae };
            };

            // 1. Current State (At Start of Star Week)
            // Represents fitness *entering* the week, based on previous 6 weeks (42 days)
            const currentWindowEnd = subDays(starStart, 1);
            const currentWindowStart = subDays(currentWindowEnd, 41); // 42 days total inclusive
            const currentMetrics = getMetricsForPeriod(currentWindowStart, currentWindowEnd);

            // 2. Historical State (6 Weeks Prior to Start)
            // Represents fitness 6 weeks before the star week
            const historyWindowEnd = subDays(starStart, 43); // 6 weeks back from start? "Difference of start... to 6 weeks ago"
            // If Start is T. "6 weeks ago" implies T - 42d.
            // So we want the state at T - 42d.
            // Window ending at T - 42d.
            const historyRefPoint = subDays(starStart, 42);
            const historyWindowStart = subDays(historyRefPoint, 42); // 6 weeks leading up to that point?
            // "Displayed metrics... for the week 6 weeks ago".
            // Rolling window displayed at T-42 would be [T-84, T-42].
            const oldMetrics = getMetricsForPeriod(historyWindowStart, historyRefPoint);

            const calcDelta = (cur, old, precision = 0) => {
                if (cur === null || cur === undefined) return null;
                if (old === null || old === undefined) return null;
                const diff = cur - old;
                return precision > 0 ? diff.toFixed(precision) : Math.round(diff);
            };

            return {
                current: currentMetrics,
                old: oldMetrics,
                deltas: {
                    ftp: calcDelta(currentMetrics.ftp, oldMetrics.ftp, 0),
                    cp: calcDelta(currentMetrics.cp, oldMetrics.cp, 0),
                    ae: calcDelta(currentMetrics.ae, oldMetrics.ae, 2)
                }
            };
        } catch (e) {
            console.error("Error calculating performance comparison", e);
            return null;
        }
    }, [workouts, starStart, ftp]);

    // --- Section 4: Breakthrough Sessions (Last 6 Weeks) ---
    const breakthroughSessions = useMemo(() => {
        try {
            const { workouts: histWorkouts } = historyData;
            if (!histWorkouts.length) return [];

            return [...histWorkouts]
                .sort((a, b) => {
                    // Scoring for "breakthrough"
                    const scoreA = (a.normalized_power || 0) * (a.intensity_factor || 0) + (a.training_stress_score || 0);
                    const scoreB = (b.normalized_power || 0) * (b.intensity_factor || 0) + (b.training_stress_score || 0);
                    return scoreB - scoreA;
                })
                .slice(0, 3)
                .map(w => ({
                    id: w.id,
                    title: w.title || 'Ride',
                    date: new Date(w.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                    np: Math.round(w.normalized_power || w.avg_power || 0),
                    tss: Math.round(w.training_stress_score || 0),
                    if: w.intensity_factor || '-',
                    bestInterval: w.power_curve?.duration_5m ? `${w.power_curve.duration_5m}W (5m)` : null
                }));
        } catch (e) {
            console.error("Error picking breakthrough sessions", e);
            return [];
        }
    }, [historyData]);

    // --- Section 5: History Analytics (Re-added to fix blank page) ---
    const historyStats = useMemo(() => {
        const defaultStats = {
            activeDays: 0,
            restDays: 42,
            weeksOff: 0,
            maxRestStreak: 0,
            avgSleep: '-',
            avgSleepQuality: '-',
            avgHrv: '-',
            avgWeeklyTss: 0,
            avgWeeklyDuration: '0.0',
            typeCounts: { Endurance: 0, Tempo: 0, Threshold: 0, VO2Max: 0, Anaerobic: 0 },
            zonePieData: []
        };

        if (!historyData) return defaultStats;

        try {
            const { workouts: hWorkouts, metrics: hMetrics } = historyData;

            // 1. Active Days (unique days with workouts in 42-day period)
            const activeDaysSet = new Set(hWorkouts.map(w => getLocalDayKey(w.date)));
            const activeDays = activeDaysSet.size;
            const restDays = 42 - activeDays;

            // 2. Recovery Analysis & Workout Classification
            let weeksOff = 0;
            // Workout Types Counts
            const typeCounts = {
                Endurance: 0,
                Tempo: 0,
                Threshold: 0,
                VO2Max: 0,
                Anaerobic: 0
            };

            // Classify all history workouts
            hWorkouts.forEach(w => {
                // Use existing utility to classify
                // We need to import classifyWorkout or define it if not available in scope
                // It is imported from '../utils/analysis'
                const type = classifyWorkout(w, ftp);
                if (typeCounts[type] !== undefined) {
                    typeCounts[type]++;
                }
            });

            // Calculate weeks off (as before)
            let maxRestStreak = 0;
            let currentRestStreak = 0;
            for (let i = 0; i < 42; i++) {
                const dayKey = getLocalDayKey(subDays(historyEnd, i));
                if (!activeDaysSet.has(dayKey)) {
                    currentRestStreak++;
                } else {
                    if (currentRestStreak > maxRestStreak) maxRestStreak = currentRestStreak;
                    currentRestStreak = 0;
                }
            }
            if (currentRestStreak > maxRestStreak) maxRestStreak = currentRestStreak;
            weeksOff = Math.floor(maxRestStreak / 7);

            // 3. Avg Sleep & HRV
            const validSleep = hMetrics.filter(m => Number(m.sleepHours) > 0);
            const avgSleep = validSleep.length ? (validSleep.reduce((acc, m) => acc + (Number(m.sleepHours) || 0), 0) / validSleep.length).toFixed(1) : '-';

            const validSleepQuality = hMetrics.filter(m => Number(m.sleepQuality) > 0);
            const avgSleepQuality = validSleepQuality.length ? Math.round(validSleepQuality.reduce((acc, m) => acc + (Number(m.sleepQuality) || 0), 0) / validSleepQuality.length) : '-';

            const validHrv = hMetrics.filter(m => Number(m.hrv) > 0);
            const avgHrv = validHrv.length ? Math.round(validHrv.reduce((acc, m) => acc + (Number(m.hrv) || 0), 0) / validHrv.length) : '-';

            // 4. Totals
            const totalTss = hWorkouts.reduce((acc, w) => acc + (Number(w.training_stress_score) || 0), 0);
            const totalDuration = hWorkouts.reduce((acc, w) => acc + (Number(w.total_elapsed_time) || 0), 0);

            const avgWeeklyTss = Math.round(totalTss / 6);
            const avgWeeklyDuration = (totalDuration / 3600 / 6).toFixed(1);

            // 5. Zone Distribution for Pie (Keep existing)
            const totalZones = Array(7).fill(0);
            hWorkouts.forEach(w => {
                const z = calculateTimeInZones(w.streams || [], ftp);
                if (z) {
                    z.forEach((zone, i) => {
                        totalZones[i] += (zone.time || 0);
                    });
                }
            });

            const zonePieData = totalZones.map((sec, i) => ({
                name: zoneNames[i],
                value: Math.round(sec / 60),
                color: zoneColors[i]
            })).filter(z => z.value > 0);

            return {
                activeDays,
                restDays,
                weeksOff,
                typeCounts, // New
                avgSleep,
                avgSleepQuality,
                avgHrv,
                avgWeeklyTss,
                avgWeeklyDuration,
                zonePieData
            };
        } catch (e) {
            console.error("Error calculating history stats", e);
            return defaultStats;
        }
    }, [historyData, ftp, historyEnd]);

    const renderContent = () => {

        return (
            <div className={styles.content}>

                {/* Performance Comparison */}
                <div className={styles.section}>
                    <h3 className={styles.sectionHeader}>Fitness Progress (vs 6 Weeks Ago)</h3>
                    <div className={styles.comparisonGrid}>
                        <div className={styles.comparisonCard}>
                            <div className={styles.compLabel}>FTP</div>
                            <div className={styles.compValue}>{performanceComparison?.current?.ftp || '-'}W</div>
                            {performanceComparison?.deltas.ftp && (
                                <div className={`${styles.compDelta} ${performanceComparison.deltas.ftp >= 0 ? styles.positive : styles.negative}`}>
                                    {performanceComparison.deltas.ftp >= 0 ? '+' : ''}{performanceComparison.deltas.ftp}W
                                </div>
                            )}
                        </div>
                        <div className={styles.comparisonCard}>
                            <div className={styles.compLabel}>Critical Power</div>
                            <div className={styles.compValue}>{performanceComparison?.current?.cp || '-'}W</div>
                            {performanceComparison?.deltas.cp && (
                                <div className={`${styles.compDelta} ${performanceComparison.deltas.cp >= 0 ? styles.positive : styles.negative}`}>
                                    {performanceComparison.deltas.cp >= 0 ? '+' : ''}{performanceComparison.deltas.cp}W
                                </div>
                            )}
                        </div>
                        <div className={styles.comparisonCard}>
                            <div className={styles.compLabel}>Aerobic Efficiency</div>
                            <div className={styles.compValue}>{performanceComparison?.current?.ae?.toFixed(2) || '-'}</div>
                            {performanceComparison?.deltas.ae && (
                                <div className={`${styles.compDelta} ${performanceComparison.deltas.ae >= 0 ? styles.positive : styles.negative}`}>
                                    {performanceComparison.deltas.ae >= 0 ? '+' : ''}{performanceComparison.deltas.ae}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Breakthrough Sessions */}
                <div className={styles.section}>
                    <h3 className={styles.sectionHeader}>Key Breakthrough Sessions (Last 6 Weeks)</h3>
                    <p className={styles.description}>Your hardest, best-executed, or highest-power rides recently.</p>
                    <div className={styles.breakthroughGrid}>
                        {breakthroughSessions.map(session => (
                            <div key={session.id} className={styles.breakthroughCard}>
                                <div className={styles.btHeader}>
                                    <span className={styles.btTitle}>{session.title}</span>
                                    <span className={styles.btDate}>{session.date}</span>
                                </div>
                                <div className={styles.btMetrics}>
                                    <div className={styles.btMetric}>
                                        <span className={styles.btMetricValue}>{session.np}W</span>
                                        <span className={styles.btMetricLabel}>NP</span>
                                    </div>
                                    <div className={styles.btMetric}>
                                        <span className={styles.btMetricValue}>{session.tss}</span>
                                        <span className={styles.btMetricLabel}>TSS</span>
                                    </div>
                                    <div className={styles.btMetric}>
                                        <span className={styles.btMetricValue}>{session.if}</span>
                                        <span className={styles.btMetricLabel}>IF</span>
                                    </div>
                                </div>
                                {session.bestInterval && (
                                    <div className={styles.btHero}>
                                        <Zap size={14} /> Hero Peak: {session.bestInterval}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* SECTION 1: Star Period */}
                <div className={styles.section}>
                    <h3 className={styles.sectionHeader}>Why you felt strong</h3>
                    <p className={styles.description}>
                        Analysis of your rides from {starStart.toLocaleDateString()} to {starEnd.toLocaleDateString()}.
                        You reported feeling strong (8/10+) in {starWorkouts.filter(w => (w.feeling_strength || 0) >= 8).length} sessions!
                    </p>

                    <div className={styles.workoutListContainer}>
                        {starWorkoutsData.length > 0 ? (
                            starWorkoutsData.map((workout) => (
                                <div key={workout.id} className={styles.workoutRow}>
                                    <div className={styles.workoutMainInfo}>
                                        <span className={styles.workoutTitle}>{workout.title}</span>
                                        <span className={styles.workoutMeta}>{workout.date} • {workout.totalMinutes}m</span>
                                    </div>
                                    <div className={styles.breakdownBar}>
                                        {workout.breakdown.map((item, idx) => (
                                            <div
                                                key={idx}
                                                className={styles.zonePill}
                                                style={{ backgroundColor: item.color }}
                                                title={`${item.name}: ${item.minutes}m`}
                                            >
                                                {item.name} {item.percent}%
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))
                        ) : (
                            <p style={{ textAlign: 'center', opacity: 0.5, padding: '20px' }}>
                                No workouts found for this 7-day star period.
                            </p>
                        )}
                    </div>
                </div>

                {/* SECTION 2: 6-Week History */}
                <div className={styles.section}>
                    <h3 className={styles.sectionHeader}>The Foundation (Previous 6 Weeks)</h3>
                    <p className={styles.description}>
                        Your performance today is the result of {historyStats.weeksOff > 0 ? `a strategic mix of training and ${historyStats.weeksOff} weeks of dedicated recovery` : 'consistent training'} from {historyStart.toLocaleDateString()} to {historyEnd.toLocaleDateString()}.
                    </p>

                    <div className={styles.statsGrid}>
                        <div className={styles.statCard} title="Total days with at least one workout">
                            <Activity size={20} className={styles.icon} color="var(--accent-primary)" />
                            <div>
                                <div className={styles.statValue}>{historyStats.activeDays}</div>
                                <div className={styles.statLabel}>Active Days</div>
                            </div>
                        </div>

                        {/* Weekly Workouts Mix */}
                        <div className={styles.statCard} style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '10px 15px' }}>
                            <div className={styles.statLabel} style={{ marginBottom: '5px' }}>Avg Weekly Workouts</div>
                            <div style={{ display: 'flex', gap: '12px', fontSize: '0.85rem' }}>
                                {historyStats.typeCounts && historyStats.typeCounts.Endurance > 0 && (
                                    <div title="Endurance Rides"><span style={{ color: '#3b82f6', fontWeight: 'bold' }}>{(historyStats.typeCounts.Endurance / 6).toFixed(1)}</span> End</div>
                                )}
                                {historyStats.typeCounts && historyStats.typeCounts.Tempo > 0 && (
                                    <div title="Tempo Rides"><span style={{ color: '#22c55e', fontWeight: 'bold' }}>{(historyStats.typeCounts.Tempo / 6).toFixed(1)}</span> Tmp</div>
                                )}
                                {historyStats.typeCounts && historyStats.typeCounts.Threshold > 0 && (
                                    <div title="Threshold Rides"><span style={{ color: '#eab308', fontWeight: 'bold' }}>{(historyStats.typeCounts.Threshold / 6).toFixed(1)}</span> Thr</div>
                                )}
                                {historyStats.typeCounts && historyStats.typeCounts.VO2Max > 0 && (
                                    <div title="VO2 Max Rides"><span style={{ color: '#f97316', fontWeight: 'bold' }}>{(historyStats.typeCounts.VO2Max / 6).toFixed(1)}</span> VO2</div>
                                )}
                                {historyStats.typeCounts && historyStats.typeCounts.Anaerobic > 0 && (
                                    <div title="Anaerobic Rides"><span style={{ color: '#ef4444', fontWeight: 'bold' }}>{(historyStats.typeCounts.Anaerobic / 6).toFixed(1)}</span> Ana</div>
                                )}
                            </div>
                        </div>

                        <div className={styles.statCard} title="Average sleep duration per night">
                            <Moon size={20} className={styles.icon} color="var(--accent-secondary)" />
                            <div>
                                <div className={styles.statValue}>{historyStats.avgSleep}h</div>
                                <div className={styles.statLabel}>Avg Sleep</div>
                            </div>
                        </div>
                        <div className={styles.statCard} title="Average subjective sleep quality (1-100)">
                            <Activity size={20} className={styles.icon} color="#22c55e" />
                            <div>
                                <div className={styles.statValue}>{historyStats.avgSleepQuality}%</div>
                                <div className={styles.statLabel}>Sleep Qual.</div>
                            </div>
                        </div>
                        <div className={styles.statCard} title="Average Heart Rate Variability">
                            <Heart size={20} className={styles.icon} color="var(--accent-danger)" />
                            <div>
                                <div className={styles.statValue}>{historyStats.avgHrv}</div>
                                <div className={styles.statLabel}>Avg HRV</div>
                            </div>
                        </div>
                    </div>

                    <div className={styles.historyCharts}>
                        <div className={styles.subChart}>
                            <h4>Weekly Averages</h4>
                            <div className={styles.bigNum}>
                                <span>{historyStats.avgWeeklyDuration}h</span>
                                <small>Duration</small>
                            </div>
                            <div className={styles.bigNum}>
                                <span>{historyStats.avgWeeklyTss}</span>
                                <small>TSS</small>
                            </div>
                        </div>

                        <div className={styles.subChart} style={{ flex: 2 }}>
                            <h4>Training Distribution (Tot. Mins)</h4>
                            <ResponsiveContainer width="100%" height={200}>
                                <PieChart>
                                    <Pie
                                        data={historyStats.zonePieData}
                                        dataKey="value"
                                        nameKey="name"
                                        cx="50%" cy="50%"
                                        outerRadius={70}
                                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                                    >
                                        {historyStats.zonePieData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.color} />
                                        ))}
                                    </Pie>
                                    <Tooltip />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>

            </div>
        );
    };

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.modal} onClick={e => e.stopPropagation()}>
                <div className={styles.header}>
                    <div className={styles.titleRow}>
                        <Trophy size={24} color="#FFD700" fill="#FFD700" />
                        <h2>Star Period Report v2 (Recovery)</h2>
                    </div>
                    <button onClick={onClose} className={styles.closeBtn}><X size={24} /></button>
                </div>
                {renderContent()}
            </div>
        </div>
    );
};

export default StarWeekReportModal;
