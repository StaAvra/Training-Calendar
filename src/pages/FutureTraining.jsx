import React, { useState, useEffect, useMemo } from 'react';
import { useUser } from '../context/UserContext';
import { db } from '../utils/db';
import { calculateTimeInZones, calculateTrainingDNA } from '../utils/analysis';
import { analyzeAdaptations, generateRecommendation } from '../utils/intelligence';
import { subDays, startOfDay, endOfDay } from 'date-fns';
import { TrendingUp, Clock, Target, ArrowRight, Brain, Zap, Activity } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid, LineChart, Line } from 'recharts';
import styles from './FutureTraining.module.css';

const FutureTraining = () => {
    const { currentUser } = useUser();
    const [workouts, setWorkouts] = useState([]);
    const [recommendation, setRecommendation] = useState(null);
    const [target, setTarget] = useState('');
    const [availHours, setAvailHours] = useState(6);
    const [daysAvailable, setDaysAvailable] = useState(5);
    const [successProfile, setSuccessProfile] = useState(null);
    const [dnaData, setDnaData] = useState(null);
    const [adaptationAnalysis, setAdaptationAnalysis] = useState(null);

    useEffect(() => {
        const fetch = async () => {
            if (!currentUser) return;
            const workoutData = await db.getWorkouts(currentUser.id);
            const metricsData = await db.getMetrics(currentUser.id);
            setWorkouts(workoutData || []);

            const dna = calculateTrainingDNA(workoutData || [], metricsData || [], currentUser.profile?.ftp);
            setDnaData(dna);

            // Run Intelligence Engine
            const analysis = analyzeAdaptations(workoutData || [], metricsData || [], []);
            setAdaptationAnalysis(analysis);
        };
        fetch();
    }, [currentUser]);

    // 1. Analyze Success Patterns
    useMemo(() => {
        if (!workouts.length || !currentUser) return;
        const ftp = currentUser.profile.ftp;

        // Find Star Periods (same logic as Calendar)
        const starDates = [];
        // Iterate all relevant days (optimization: just check days with existing workouts as end-points?)
        // Let's iterate sorted workouts dates.
        const sorted = [...workouts].sort((a, b) => new Date(a.date) - new Date(b.date));
        if (!sorted.length) return;

        const first = new Date(sorted[0].date);
        const last = new Date(sorted[sorted.length - 1].date);

        // Scan every day? Maybe expensive. Let's scan every workout date.
        // A Star Period is defined by the day it completes.
        const starBlocks = [];

        for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
            const day = new Date(d);
            const winStart = subDays(day, 6);

            const valid = workouts.filter(w => {
                const wd = new Date(w.date);
                return wd >= winStart && wd <= endOfDay(day);
            });

            const highFeeling = valid.filter(w => (w.feeling_strength || 0) >= 8).length;

            if (highFeeling >= 3) {
                // Found a Star Period. Analyze the PRECEDING 6 WEEKS leading up to this success.
                const blockEnd = day;
                const blockStart = subDays(day, 42);

                const blockWorkouts = workouts.filter(w => {
                    const wd = new Date(w.date);
                    return wd >= blockStart && wd <= blockEnd;
                });

                // Calc Stats
                const totalSecs = blockWorkouts.reduce((acc, w) => acc + (w.total_elapsed_time || 0), 0);
                const avgHrs = (totalSecs / 3600) / 6;

                // Zone Dist
                const zTimes = [0, 0, 0, 0, 0, 0, 0];
                blockWorkouts.forEach(w => {
                    if (w.streams) {
                        const z = calculateTimeInZones(w.streams, ftp);
                        z.forEach((zone, i) => zTimes[i] += zone.time);
                    }
                });

                const totalZTime = zTimes.reduce((a, b) => a + b, 0) || 1;
                const zDist = zTimes.map(t => t / totalZTime); // percentages

                starBlocks.push({ avgHrs, zDist, date: day });
            }
        }

        if (starBlocks.length > 0) {
            // Average the profiles of all star blocks
            const avgHrs = starBlocks.reduce((acc, b) => acc + b.avgHrs, 0) / starBlocks.length;
            const avgZDist = [0, 0, 0, 0, 0, 0, 0];
            starBlocks.forEach(b => {
                b.zDist.forEach((p, i) => avgZDist[i] += p);
            });
            const finalZDist = avgZDist.map(t => (t / starBlocks.length) * 100); // 0-100 scale

            setSuccessProfile({
                avgHrs: avgHrs.toFixed(1),
                zDist: finalZDist,
                count: starBlocks.length
            });
        }

    }, [workouts, currentUser]);

    // 2. Generate Recommendation
    const generatePlan = () => {
        if (!target || !currentUser) return;

        // Fallback for analysis if not yet loaded
        const analysis = adaptationAnalysis || { insufficientData: true };

        const rec = generateRecommendation(
            analysis,
            currentUser.profile,
            target,
            availHours,
            daysAvailable
        );

        // Use the data-driven focusZones returned from intelligence.js
        setRecommendation({
            title: rec.title,
            description: rec.description,
            focusZones: rec.focusZones,
            weeklyPlan: rec.weeklyPlan,
            fourWeekPlan: rec.fourWeekPlan
        });
    };

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Future Training</h1>
                <p className="text-muted">Analyze your successful habits and plan your next phase.</p>
            </header>

            <div className={styles.grid}>

                {/* 1. Success DNA */}
                <div className={styles.biocard}>
                    <div className={styles.cardHeader}>
                        <Brain size={24} color="var(--accent-primary)" />
                        <h3>Your Training DNA</h3>
                    </div>
                    {dnaData ? (
                        <div className={styles.dnaContent}>
                            <p className="text-sm text-muted" style={{ marginBottom: '1.5rem' }}>
                                12-week workout distribution trends:
                            </p>

                            <div style={{ width: '100%', height: 300, marginBottom: '2rem' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={dnaData.weeklyTrends}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                                        <XAxis dataKey="weekLabel" stroke="var(--text-secondary)" fontSize={12} />
                                        <YAxis stroke="var(--text-secondary)" fontSize={12} label={{ value: 'Rides (Trend)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                                            itemStyle={{ color: 'var(--text-primary)' }}
                                            formatter={(value, name) => [typeof value === 'number' ? value.toFixed(1) : value, name.replace('Trend', '')]}
                                        />
                                        <Legend wrapperStyle={{ paddingTop: '10px' }} />
                                        <Line type="monotone" dataKey="RecoveryTrend" name="Recovery" stroke="#888888" strokeWidth={3} dot={false} />
                                        <Line type="monotone" dataKey="EnduranceTrend" name="Endurance" stroke="#3b82f6" strokeWidth={3} dot={false} />
                                        <Line type="monotone" dataKey="TempoTrend" name="Tempo" stroke="#22c55e" strokeWidth={3} dot={false} />
                                        <Line type="monotone" dataKey="ThresholdTrend" name="Threshold" stroke="#eab308" strokeWidth={3} dot={false} />
                                        <Line type="monotone" dataKey="VO2MaxTrend" name="VO2Max" stroke="#f97316" strokeWidth={3} dot={false} />
                                        <Line type="monotone" dataKey="AnaerobicTrend" name="Anaerobic" stroke="#ef4444" strokeWidth={3} dot={false} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>

                            <div className={styles.averagesSection}>
                                <div className={styles.avgStat}>
                                    <span className={styles.avgVal}>{dnaData.longTermAverages.tssPerWeek}</span>
                                    <label>Avg Weekly TSS <small>(12w)</small></label>
                                </div>
                                <div className={styles.avgStat}>
                                    <span className={styles.avgVal}>{dnaData.longTermAverages.hrsPerWeek}h</span>
                                    <label>Avg Weekly Vol <small>(12w)</small></label>
                                </div>
                            </div>

                            <div style={{ borderTop: '1px solid var(--border-color)', margin: 'var(--space-xl) 0', paddingTop: 'var(--space-lg)' }}>
                                {dnaData.winningFormula ? (
                                    <>
                                        <h4 className="text-xs text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-md)', letterSpacing: '0.05em' }}>Winning Formula (Lead-up to Peak)</h4>
                                        <div className={styles.formulaGrid}>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.tssPerWeek}</span>
                                                <label>TSS / Week</label>
                                            </div>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.hrsPerWeek}h</span>
                                                <label>Volume / Week</label>
                                            </div>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.sleepPerDay}h</span>
                                                <label>Sleep / Day</label>
                                            </div>
                                            <div className={styles.formulaStat}>
                                                <span className={styles.formulaVal}>{dnaData.winningFormula.hrvPerDay}</span>
                                                <label>HRV / Day</label>
                                            </div>
                                        </div>

                                        <div className={styles.distributionSection} style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
                                            <h4 className="text-xs text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-md)', letterSpacing: '0.05em' }}>Peak Session Mix</h4>
                                            <div className={styles.distGrid}>
                                                {Object.entries(dnaData.winningFormula.distribution).map(([type, count]) => (
                                                    <div key={type} className={styles.distItem}>
                                                        <span className={styles.distCount}>{count}</span>
                                                        <span className={styles.distLabel}>{type}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                                        <p className="text-sm">
                                            <strong>Winning Formula Analysis:</strong><br />
                                            {dnaData.bestWeekStart ?
                                                `Your best week was around ${dnaData.bestWeekStart} (Feeling: ${dnaData.avgFeeling}/10), but we need more history to analyze the lead-up.` :
                                                "No clear 'Peak Week' detected in the last 3 months (High Volume + High Feeling)."}
                                            <br /><span style={{ fontSize: '0.8em', opacity: 0.8 }}>Keep logging rides and feeling scores to unlock this section!</span>
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-center" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                            <p>No workout data available for analysis.</p>
                        </div>
                    )}
                </div>

                {/* 2. Planner Form */}
                <div className={styles.formCard}>
                    <div className={styles.cardHeader}>
                        <Target size={24} color="var(--accent-secondary)" />
                        <h3>Set Your Goals</h3>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Primary Focus</label>
                        <select value={target} onChange={e => setTarget(e.target.value)} className={styles.select}>
                            <option value="">Select a goal...</option>
                            <option value="endurance">Endurance & Stability (Fondos/Centuries)</option>
                            <option value="climbing">Climbing & Sustained Power (Threshold)</option>
                            <option value="speed">Speed, Crits & Punchiness (VO2 Max)</option>
                        </select>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Weekly Availability (Hours)</label>
                        <input
                            type="range" min="3" max="15" step="1"
                            value={availHours} onChange={e => setAvailHours(Number(e.target.value))}
                            className={styles.range}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <span>3h</span>
                            <span style={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}>{availHours} hrs</span>
                            <span>15h+</span>
                        </div>
                    </div>

                    <div className={styles.formGroup}>
                        <label>Training Days per Week</label>
                        <input
                            type="range" min="2" max="7" step="1"
                            value={daysAvailable} onChange={e => setDaysAvailable(Number(e.target.value))}
                            className={styles.range}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <span>2 days</span>
                            <span style={{ color: 'var(--accent-primary)', fontWeight: 'bold' }}>{daysAvailable} days</span>
                            <span>7 days</span>
                        </div>
                    </div>

                    <button
                        onClick={generatePlan}
                        disabled={!target}
                        className={styles.generateBtn}
                    >
                        Generate Recommendations <ArrowRight size={16} />
                    </button>
                </div>

                {/* 3. Recommendation Engine */}
                {recommendation && (
                    <div className={styles.recCard}>
                        <h2 className={styles.recTitle}>{recommendation.title}</h2>

                        <div className={styles.recBody}>
                            <div className={styles.recText}>
                                <div className={styles.recDesc}>
                                    {recommendation.description.split('\n\n').map((para, i) => (
                                        <p key={i} dangerouslySetInnerHTML={{
                                            __html: para.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                                                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                                        }} style={{ marginBottom: '1rem' }} />
                                    ))}
                                </div>

                                {/* Weekly Session Plan */}
                                {recommendation.weeklyPlan && (
                                    <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
                                        <h4 style={{ marginBottom: '1rem', fontSize: '0.95rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Weekly Training Breakdown</h4>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                                            {recommendation.weeklyPlan.sessions.map((session, i) => (
                                                <div key={i} style={{
                                                    padding: '1rem',
                                                    background: 'var(--bg-secondary)',
                                                    borderRadius: '8px',
                                                    border: '1px solid var(--border-color)'
                                                }}>
                                                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                                        {session.type}
                                                    </div>
                                                    <div style={{ fontSize: '1.3rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                                                        {session.count}x
                                                    </div>
                                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                        {session.hoursPerSession.toFixed(1)}h each
                                                    </div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: 500 }}>
                                                        {session.totalWeekly.toFixed(1)}h total
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.9rem' }}>
                                            <strong>Total Weekly:</strong> {recommendation.weeklyPlan.totalWeeklyHours}h across {recommendation.weeklyPlan.sessionsPerWeek} sessions
                                        </div>
                                    </div>
                                )}

                                {/* 4-Week Progressive Plan */}
                                {recommendation.fourWeekPlan && (
                                    <div style={{ marginTop: '2.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
                                        <div style={{ marginBottom: '1.5rem' }}>
                                            <h4 style={{ marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>4-Week Progressive Block</h4>
                                            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0 }}>
                                                <strong>Strategy:</strong> {recommendation.fourWeekPlan.progressionType} Progression
                                            </p>
                                            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.5rem 0 0 0' }}>
                                                {recommendation.fourWeekPlan.rationale}
                                            </p>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
                                            {recommendation.fourWeekPlan.weeks.map((week, i) => (
                                                <div key={i} style={{
                                                    padding: '1.25rem',
                                                    background: 'var(--bg-secondary)',
                                                    borderRadius: '8px',
                                                    border: `2px solid ${week.weekNumber === 3 ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                                    position: 'relative'
                                                }}>
                                                    {/* Peak week indicator */}
                                                    {week.weekNumber === 3 && (
                                                        <div style={{
                                                            position: 'absolute',
                                                            top: '-10px',
                                                            right: '10px',
                                                            background: 'var(--accent-primary)',
                                                            color: 'white',
                                                            fontSize: '0.7rem',
                                                            padding: '0.3rem 0.6rem',
                                                            borderRadius: '12px',
                                                            fontWeight: 'bold',
                                                            textTransform: 'uppercase'
                                                        }}>
                                                            Peak
                                                        </div>
                                                    )}

                                                    <div style={{ marginBottom: '0.75rem' }}>
                                                        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                                            Week {week.weekNumber}
                                                        </div>
                                                        <div style={{ fontSize: '1rem', fontWeight: 'bold', color: 'var(--accent-primary)' }}>
                                                            {week.focus}
                                                        </div>
                                                    </div>

                                                    {/* Session breakdown for this week */}
                                                    <div style={{ marginBottom: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                                                        {week.sessions.map((session, j) => (
                                                            <div key={j} style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                                                                <span style={{ color: 'var(--text-secondary)' }}>{session.count}x {session.type}:</span>
                                                                <span style={{ fontWeight: 500, marginLeft: '0.25rem' }}>
                                                                    {session.totalWeekly.toFixed(1)}h
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>

                                                    {/* Total hours */}
                                                    <div style={{
                                                        padding: '0.75rem',
                                                        background: 'var(--bg-primary)',
                                                        borderRadius: '6px',
                                                        textAlign: 'center',
                                                        borderTop: '1px solid var(--border-color)',
                                                        paddingTop: '0.75rem'
                                                    }}>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                                                            Total Hours
                                                        </div>
                                                        <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--accent-primary)' }}>
                                                            {week.totalWeeklyHours}h
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.9rem' }}>
                                            <strong>4-Week Total:</strong> {recommendation.fourWeekPlan.totalPlanHours}h
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className={styles.recChart}>
                                <h4>Recommended Distribution</h4>
                                <ResponsiveContainer width="100%" height={200}>
                                    <PieChart>
                                        <Pie
                                            data={recommendation.focusZones}
                                            dataKey="value"
                                            nameKey="name"
                                            cx="50%" cy="50%"
                                            innerRadius={40}
                                            outerRadius={70}
                                        >
                                            {recommendation.focusZones.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Pie>
                                        <Tooltip />
                                        <Legend />
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default FutureTraining;
