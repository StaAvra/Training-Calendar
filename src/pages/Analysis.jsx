import React, { useEffect, useState } from 'react';
import { subWeeks, startOfDay } from 'date-fns';
import { useUser } from '../context/UserContext';
import { db } from '../utils/db';
import { calculateTimeInZones, calculateZones, calculateEstimatedFtp, calculateCriticalPower, calculateCriticalHeartRate, calculatePhenotype, calculateSessionDerivedFtp, checkFtpImprovement, calculateTssWithMetadata, calculateTimeInHRZones, calculateHRZones, calculateInterpolatedScore } from '../utils/analysis';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LineChart, Line, ReferenceLine } from 'recharts';
import { Activity, TrendingUp, Calculator, Zap, Heart } from 'lucide-react';
import Modal from '../components/Modal'; // Reuse Modal
import styles from './Analysis.module.css';

const Analysis = () => {
    const { currentUser } = useUser();
    const [workouts, setWorkouts] = useState([]);
    const [zoneData, setZoneData] = useState([]);
    const [hrZoneData, setHrZoneData] = useState([]);
    const [loading, setLoading] = useState(true);

    // Power Curve & CP State
    const [powerCurve, setPowerCurve] = useState([]);
    const [allTimePowerCurve, setAllTimePowerCurve] = useState([]);
    const [criticalPower, setCriticalPower] = useState(null);
    const [criticalHeartRate, setCriticalHeartRate] = useState(null);
    const [sessionDerivedFtp, setSessionDerivedFtp] = useState(null);
    const [efData, setEfData] = useState([]);
    const [allTimeEfData, setAllTimeEfData] = useState([]);

    // FTP Modal State
    const [isFtpModalOpen, setIsFtpModalOpen] = useState(false);
    const [estimatedFtp, setEstimatedFtp] = useState(null);
    const [ftpMessage, setFtpMessage] = useState('');
    const [ftpSuggestion, setFtpSuggestion] = useState(null);

    useEffect(() => {
        const fetchData = async () => {
            if (!currentUser) return;
            const storedWorkouts = await db.getWorkouts(currentUser.id);
            setWorkouts(storedWorkouts || []);
            setLoading(false);
        };
        fetchData();
    }, [currentUser]);

    // Phenotype state
    const [phenotype, setPhenotype] = useState({ type: 'All-Rounder', adj: 0 });

    // HR-based TSS estimates
    const [hrBasedTssEstimates, setHrBasedTssEstimates] = useState([]);

    useEffect(() => {
        if (!workouts.length || !currentUser) return;

        // 1. Cutoff Dates
        const now = new Date();
        const cutoff6Weeks = startOfDay(subWeeks(now, 6));
        const cutoff4Weeks = startOfDay(subWeeks(now, 4));

        // 2. Filter Workouts for Rolling Metrics
        const recentWorkouts = workouts.filter(w => new Date(w.date) >= cutoff6Weeks);

        // 3. Aggregate Time in Zones (Last 4 Weeks)
        const zones = calculateZones(currentUser.profile.ftp);
        const aggregatedZones = zones.map(z => ({ name: z.name, time: 0, color: z.color }));

        // HR Zones (Last 4 Weeks)
        const maxHr = currentUser.profile.maxHr || 190; // Default to 190 if not provided
        const hrZones = calculateHRZones(maxHr);
        const aggregatedHrZones = hrZones.map(z => ({ name: z.name, time: 0, color: z.color }));

        // 4. Aggregate Power Curve (Last 6 Weeks vs All Time)
        const curveBests = {
            duration_5s: 0, duration_10s: 0,
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const allTimeCurveBests = {
            duration_5s: 0, duration_10s: 0,
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const hrBests = {
            duration_1m: 0, duration_2m: 0, duration_3m: 0, duration_5m: 0,
            duration_8m: 0, duration_10m: 0, duration_20m: 0, duration_60m: 0
        };

        const efPoints = [];
        const allTimeEfPoints = [];

        // Scan ALL workouts
        workouts.forEach(workout => {
            const wDate = new Date(workout.date);

            // Time in Zones (4 Weeks)
            if (wDate >= cutoff4Weeks && workout.streams) {
                const distribution = calculateTimeInZones(workout.streams, currentUser.profile.ftp);
                distribution.forEach((d, i) => {
                    aggregatedZones[i].time += (d.time / 60);
                });

                // Time in HR Zones (4 Weeks)
                const hrDistribution = calculateTimeInHRZones(workout.streams, maxHr);
                hrDistribution.forEach((d, i) => {
                    aggregatedHrZones[i].time += (d.time / 60);
                });
            }

            // All-Time Power Curve
            if (workout.power_curve) {
                Object.keys(allTimeCurveBests).forEach(key => {
                    if ((workout.power_curve[key] || 0) > allTimeCurveBests[key]) {
                        allTimeCurveBests[key] = workout.power_curve[key];
                    }
                });
            }

            // All-Time EF
            const np = workout.normalized_power || workout.avg_power;
            const hr = workout.avg_heart_rate;
            const durationMin = workout.total_elapsed_time / 60;
            const ifVal = workout.intensity_factor || (np / (currentUser.profile?.ftp || 250));

            if (ifVal && ifVal <= 0.75 && durationMin >= 30 && np && hr > 0) {
                allTimeEfPoints.push({
                    date: new Date(workout.date).getTime(), // Use timestamp for graph
                    ef: Number((np / hr).toFixed(2))
                });
            }

            // Last 6 Weeks Specifics
            if (wDate >= cutoff6Weeks) {
                if (workout.power_curve) {
                    Object.keys(curveBests).forEach(key => {
                        if ((workout.power_curve[key] || 0) > curveBests[key]) {
                            curveBests[key] = workout.power_curve[key];
                        }
                    });
                }
                if (workout.heart_rate_curve) {
                    Object.keys(hrBests).forEach(key => {
                        if ((workout.heart_rate_curve[key] || 0) > hrBests[key]) {
                            hrBests[key] = workout.heart_rate_curve[key];
                        }
                    });
                }

                if (ifVal && ifVal <= 0.75 && durationMin >= 30 && np && hr > 0) {
                    efPoints.push({
                        date: new Date(workout.date).getTime(),
                        ef: Number((np / hr).toFixed(2))
                    });
                }
            }
        });

        const finalZoneData = aggregatedZones.map(z => ({ ...z, time: Number(z.time.toFixed(1)) }));
        setZoneData(finalZoneData);

        const finalHrZoneData = aggregatedHrZones.map(z => ({ ...z, time: Number(z.time.toFixed(1)) }));
        setHrZoneData(finalHrZoneData);

        // Calculate HR-based TSS estimates for workouts without power data
        const hrBasedEstimates = [];
        workouts.forEach(workout => {
            // Only estimate for rides without power but with HR
            const np = workout.normalized_power || workout.avg_power;
            if (!np && workout.avg_heart_rate && workout.total_elapsed_time) {
                const result = calculateTssWithMetadata(workout, currentUser.profile?.ftp);
                if (result.tss) {
                    hrBasedEstimates.push({
                        id: workout.id,
                        date: new Date(workout.date).toLocaleDateString(),
                        tss: result.tss,
                        method: result.method,
                        confidence: (result.confidence * 100).toFixed(0),
                        ifEstimate: result.ifEstimate?.toFixed(2)
                    });
                }
            }
        });
        setHrBasedTssEstimates(hrBasedEstimates);

        efPoints.sort((a, b) => a.date - b.date);
        setEfData(efPoints);
        allTimeEfPoints.sort((a, b) => a.date - b.date);
        setAllTimeEfData(allTimeEfPoints);

        const labels = {
            duration_5s: '5s', duration_10s: '10s',
            duration_1m: '1m', duration_2m: '2m', duration_3m: '3m', duration_5m: '5m',
            duration_8m: '8m', duration_10m: '10m', duration_20m: '20m', duration_60m: '60m'
        };

        const order = ['duration_5s', 'duration_10s', 'duration_1m', 'duration_2m', 'duration_3m', 'duration_5m', 'duration_8m', 'duration_10m', 'duration_20m', 'duration_60m'];

        const curveChartData = Object.keys(curveBests).map(key => ({
            name: labels[key],
            time: key,
            power: curveBests[key],
            allTimePower: allTimeCurveBests[key]
        })).filter(d => d.power > 0 || d.allTimePower > 0);

        curveChartData.sort((a, b) => order.indexOf(a.time) - order.indexOf(b.time));
        setPowerCurve(curveChartData);

        // Detect Phenotype
        const detectedPhenotype = calculatePhenotype(curveBests, currentUser.profile.weight || 70);
        setPhenotype(detectedPhenotype);

        // CP & CHR (6-Week bests)
        setCriticalPower(calculateCriticalPower(curveBests));
        setCriticalHeartRate(calculateCriticalHeartRate(hrBests));

        // Session Derived FTP
        setSessionDerivedFtp(calculateSessionDerivedFtp(recentWorkouts));

        // FTP improvement suggestion (use profile for CHR fallback)
        try {
            const suggestion = checkFtpImprovement(workouts, currentUser.profile?.ftp, currentUser.profile);
            setFtpSuggestion(suggestion);
        } catch (e) {
            setFtpSuggestion(null);
        }

    }, [workouts, currentUser]);

    // Prepare performance profile mapping (internal categories)
    const categoryOrder = ['Untrained', 'Fair', 'Moderate', 'Good', 'Very good', 'Excellent', 'Exceptional'];
    const categoryToScore = Object.fromEntries(categoryOrder.map((c, i) => [c, i]));
    // Shift displayed labels one up: Untrained->Fair, Fair->Moderate, ..., Exceptional->Exceptional
    const displayLabels = categoryOrder.slice(1).concat(categoryOrder[categoryOrder.length - 1]);
    const shiftMap = Object.fromEntries(categoryOrder.map((c, i) => [c, displayLabels[i]]));

    // Original color palette per internal category (Untrained..Exceptional)
    const baseColors = ['#ef4444', '#f97316', '#f59e0b', '#fbbf24', '#34d399', '#60a5fa', '#7c3aed'];
    // Map display labels to colors shifted up so the displayed 'Fair' uses previous 'Untrained' color
    const displayColor = Object.fromEntries(displayLabels.map((lab, i) => [lab, baseColors[i]]));

    // Color mapping for categories (from low -> high)
    const categoryColor = {
        'Untrained': '#ef4444', // red
        'Fair': '#f97316', // orange
        'Moderate': '#f59e0b', // amber
        'Good': '#fbbf24', // yellow
        'Very good': '#34d399', // green
        'Excellent': '#60a5fa', // light blue
        'Exceptional': '#7c3aed' // purple
    };

    // Calculate normalized profile data using linear interpolation for fine-grained scoring
    const profileData = (() => {
        if (!phenotype || !phenotype.scores || !phenotype.performanceBreakdown) return [];

        const sex = currentUser?.profile?.sex || 'male';

        // Step 1: Get raw W/kg values and calculate interpolated scores
        const rawScores = [
            {
                name: '5s',
                key: 'sprint',
                raw: phenotype.scores.sprint,
                category: phenotype.performanceBreakdown.categories.sprint,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.sprint, 'sprint', sex)
            },
            {
                name: '1m',
                key: 'anaerobic',
                raw: phenotype.scores.anaerobic,
                category: phenotype.performanceBreakdown.categories.anaerobic,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.anaerobic, 'anaerobic', sex)
            },
            {
                name: '5m',
                key: 'vo2max',
                raw: phenotype.scores.vo2max,
                category: phenotype.performanceBreakdown.categories.vo2max,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.vo2max, 'vo2max', sex)
            },
            {
                name: '20m',
                key: 'threshold',
                raw: phenotype.scores.threshold,
                category: phenotype.performanceBreakdown.categories.threshold,
                interpolatedScore: calculateInterpolatedScore(phenotype.scores.threshold, 'threshold', sex)
            }
        ];

        // Debug logging
        console.log('Performance Profile Debug:', {
            phenotypeScores: phenotype.scores,
            rawScores: rawScores.map(s => ({
                name: s.name,
                raw: s.raw,
                interpolatedScore: s.interpolatedScore
            })),
            sex
        });

        // Step 2: Find the highest interpolated score (user's strongest discipline)
        const maxInterpolatedScore = Math.max(...rawScores.map(s => s.interpolatedScore));

        if (maxInterpolatedScore === 0) return [];

        // Step 3: Normalize interpolated scores to 100 (where 100 = strongest discipline)
        return rawScores.map(score => {
            const normalized = (score.interpolatedScore / maxInterpolatedScore) * 100;
            // Color gradient based on normalized score
            const getColor = (norm) => {
                if (norm >= 95) return '#22c55e'; // Green for strongest
                if (norm >= 85) return '#84cc16'; // Light green
                if (norm >= 75) return '#eab308'; // Yellow
                if (norm >= 65) return '#f97316'; // Orange
                return '#ef4444'; // Red for weakest
            };

            return {
                ...score,
                value: normalized,
                color: getColor(normalized)
            };
        });
    })();

    const ProfileTooltip = ({ active, payload, label }) => {
        if (!active || !payload || !payload.length) return null;
        const p = payload[0].payload;
        return (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '8px', color: 'var(--text-primary)' }}>
                <div style={{ fontWeight: 700 }}>{label}</div>
                <div style={{ marginTop: 6 }}>Normalized Score: {p.value ? p.value.toFixed(1) : '—'}</div>
                <div>W/kg: {p.raw ? Number(p.raw).toFixed(2) : '—'}</div>
                <div style={{ fontSize: '0.85em', color: 'var(--text-secondary)', marginTop: 4 }}>Category: {p.category ? (shiftMap[p.category] || p.category) : '—'}</div>
            </div>
        );
    };

    const handleEstimateFtp = () => {
        setLoading(true);
        setTimeout(() => {
            const cutoff6Weeks = subWeeks(new Date(), 6);
            const recentWorkouts = workouts.filter(w => new Date(w.date) >= cutoff6Weeks);

            const estimate = calculateEstimatedFtp(recentWorkouts, phenotype);
            const current = currentUser.profile.ftp;

            if (estimate) {
                setEstimatedFtp(estimate.avg);
                const rangeStr = `${estimate.low}W - ${estimate.high}W`;
                if (estimate.avg > current) {
                    setFtpMessage(`Based on your Last 6 Weeks and ${phenotype.type} phenotype, your FTP is estimated at ${estimate.avg}W (${rangeStr}). Current: ${current}W.`);
                } else {
                    setFtpMessage(`Based on your Last 6 Weeks, your FTP is estimated at ${estimate.avg}W (${rangeStr}).`);
                }
            } else {
                setEstimatedFtp(null);
                setFtpMessage("Not enough 8-20min efforts in the last 6 weeks to estimate FTP.");
            }
            setIsFtpModalOpen(true);
            setLoading(false);
        }, 100);
    };

    const confirmFtpUpdate = async () => {
        if (!estimatedFtp) return;
        const updatedProfile = { ...currentUser.profile, ftp: estimatedFtp };
        await db.updateUser(currentUser.id, { profile: updatedProfile });
        setEstimatedFtp(null);
        setFtpMessage('FTP updated — saved to your profile.');
        setIsFtpModalOpen(false);
    };

    const applyFtpSuggestion = async () => {
        if (!ftpSuggestion || !ftpSuggestion.suggestedUpdate) return;
        const updatedProfile = { ...currentUser.profile, ftp: ftpSuggestion.suggestedUpdate };
        await db.updateUser(currentUser.id, { profile: updatedProfile });
        setFtpSuggestion(null);
        setFtpMessage(`Applied suggested FTP: ${updatedProfile.ftp} W`);
    };

    if (loading) return <div className="container">Loading analysis...</div>;

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Training Analysis</h1>
                <p className="text-muted">Deep dive into your training intensity and effectiveness. {workouts.length > 0 && `(Latest ride: ${new Date([...workouts].sort((a, b) => new Date(b.date) - new Date(a.date))[0].date).toLocaleDateString()})`}</p>
            </header>

            {workouts.length === 0 ? (
                <div className="card" style={{ textAlign: 'center', padding: 'var(--space-2xl)' }}>
                    <Activity size={48} color="var(--text-secondary)" style={{ marginBottom: 'var(--space-md)' }} />
                    <h3 className="text-lg">No Data Available</h3>
                    <p className="text-muted">Upload workout files to see your analysis.</p>
                </div>
            ) : (
                <div className={styles.grid}>

                    {/* Strengths & Weaknesses */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Athlete Profile</h3>
                            <span className="text-sm text-muted">Analysis based on your power-to-weight ratio profile.</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-lg)' }}>
                            <div>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)', textTransform: 'uppercase' }}>Strengths</h4>
                                <ul style={{ listStyle: 'none', padding: 0 }}>
                                    {phenotype.strengths?.map(s => (
                                        <li key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#22c55e', fontWeight: 600 }}>
                                            <Zap size={16} /> {s}
                                        </li>
                                    )) || <li className="text-muted">Analyzing...</li>}
                                </ul>
                            </div>
                            <div>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)', textTransform: 'uppercase' }}>Focus Areas</h4>
                                <ul style={{ listStyle: 'none', padding: 0 }}>
                                    {phenotype.weaknesses?.map(w => (
                                        <li key={w} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                                            <TrendingUp size={16} /> {w}
                                        </li>
                                    )) || <li className="text-muted">Analyzing...</li>}
                                </ul>
                            </div>
                            <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: 'var(--space-lg)' }}>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)', textTransform: 'uppercase' }}>Phenotype</h4>
                                <p className="text-lg" style={{ fontWeight: 600 }}>{phenotype.type}</p>
                            </div>
                        </div>
                    </div>

                    {/* Performance Profile (W/kg vs benchmarks) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Performance Profile</h3>
                            <span className="text-sm text-muted">Relative strengths normalized to your strongest discipline (100 = your best).</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-lg)', alignItems: 'center' }}>
                            <div style={{ height: '260px', width: '100%' }}>
                                {profileData.length > 0 ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={profileData} margin={{ top: 20, right: 20, left: 10, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                            <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                            <YAxis
                                                stroke="var(--text-secondary)"
                                                fontSize={12}
                                                tickLine={false}
                                                axisLine={false}
                                                domain={[0, 100]}
                                                ticks={[0, 25, 50, 75, 100]}
                                                tickFormatter={(v) => `${v}`}
                                                label={{ value: 'Normalized Score', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }}
                                            />
                                            <Tooltip content={<ProfileTooltip />} />
                                            <ReferenceLine y={100} stroke="#22c55e" strokeDasharray="3 3" label={{ value: 'Peak', position: 'right', fill: '#22c55e', fontSize: 11 }} />
                                            <ReferenceLine y={75} stroke="var(--border-color)" strokeDasharray="3 3" />
                                            <ReferenceLine y={50} stroke="var(--border-color)" strokeDasharray="3 3" />
                                            <ReferenceLine y={25} stroke="var(--border-color)" strokeDasharray="3 3" />
                                            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                                                {profileData.map((entry, i) => (
                                                    <Cell key={`cell-${i}`} fill={entry.color || '#7c3aed'} />
                                                ))}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                ) : (
                                    <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>Not enough power data yet.</div>
                                )}
                            </div>
                            <div style={{ padding: 'var(--space-sm)' }}>
                                <h4 className="text-sm text-muted" style={{ marginBottom: 'var(--space-xs)' }}>Profile Level</h4>
                                <p style={{ fontSize: '1rem', fontWeight: 700 }}>{phenotype.performanceBreakdown?.overallLevel ? (shiftMap[phenotype.performanceBreakdown.overallLevel] || phenotype.performanceBreakdown.overallLevel) : 'Unknown'}</p>
                                <div style={{ marginTop: 'var(--space-md)' }}>
                                    <h5 className="text-sm text-muted">Per-Metric Categories</h5>
                                    <ul style={{ listStyle: 'none', padding: 0, marginTop: '6px' }}>
                                        <li><strong>5s:</strong> {phenotype.performanceBreakdown?.categories?.sprint ? (shiftMap[phenotype.performanceBreakdown.categories.sprint] || phenotype.performanceBreakdown.categories.sprint) : '—'}</li>
                                        <li><strong>1m:</strong> {phenotype.performanceBreakdown?.categories?.anaerobic ? (shiftMap[phenotype.performanceBreakdown.categories.anaerobic] || phenotype.performanceBreakdown.categories.anaerobic) : '—'}</li>
                                        <li><strong>5m:</strong> {phenotype.performanceBreakdown?.categories?.vo2max ? (shiftMap[phenotype.performanceBreakdown.categories.vo2max] || phenotype.performanceBreakdown.categories.vo2max) : '—'}</li>
                                        <li><strong>20m:</strong> {phenotype.performanceBreakdown?.categories?.threshold ? (shiftMap[phenotype.performanceBreakdown.categories.threshold] || phenotype.performanceBreakdown.categories.threshold) : '—'}</li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Power Duration Curve via Recharts */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Power Duration Curve (Last 6 Weeks)</h3>
                            <span className="text-sm text-muted">Peak power for key durations.</span>
                        </div>
                        <div style={{ height: '300px', width: '100%' }}>
                            {powerCurve.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={powerCurve} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)' }} />
                                        <Tooltip
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                            cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                                        />
                                        <Line type="monotone" dataKey="allTimePower" name="All-Time" stroke="var(--text-muted)" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={true} />
                                        <Line type="monotone" dataKey="power" name="Last 6 Weeks" stroke="var(--accent-primary)" strokeWidth={2} dot={{ r: 4, fill: 'var(--accent-primary)' }} activeDot={{ r: 6 }} isAnimationActive={true} />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Not enough power data yet.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Aerobic Efficiency Trend (EF) */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <h3 className="text-lg">Aerobic Efficiency Trend (Last 6 Weeks)</h3>
                                <div title="Efficiency Factor (Normalized Power / Avg HR) for aerobic rides (IF < 0.75). rising trend = improved fitness." style={{ cursor: 'help', fontSize: '0.9em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <span className="text-sm text-muted">Sub-maximal fitness tracking (NP / HR)</span>
                        </div>
                        <div style={{ height: '250px', width: '100%' }}>
                            {efData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                        <XAxis
                                            dataKey="date"
                                            type="number"
                                            domain={['auto', 'auto']}
                                            scale="time"
                                            stroke="var(--text-secondary)"
                                            fontSize={12}
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(val) => new Date(val).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                        />
                                        <YAxis domain={['auto', 'auto']} stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                        <Tooltip
                                            labelFormatter={(val) => new Date(val).toLocaleDateString()}
                                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                            cursor={{ stroke: 'var(--border-color)', strokeWidth: 1 }}
                                        />
                                        <Line data={allTimeEfData} type="monotone" dataKey="ef" name="All-Time EF" stroke="var(--text-muted)" strokeWidth={1} dot={false} strokeDasharray="3 3" connectNulls />
                                        <Line data={efData} type="monotone" dataKey="ef" name="Last 6 Weeks" stroke="#22c55e" strokeWidth={2} dot={{ r: 3, fill: '#22c55e' }} activeDot={{ r: 5 }} connectNulls />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)' }}>
                                    Need more aerobic rides (IF ≤ 0.75, ≥ 30min) to show trend.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Critical Power Stats */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted">Critical Power (CP)</span>
                                <div title="Theoretical aerobic ceiling (Monod & Scherrer model) with ± LoA range" style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <Zap size={20} color="var(--accent-warning)" />
                        </div>
                        {criticalPower ? (
                            <>
                                <p className="text-xl">{criticalPower.cp} W</p>
                                <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                                    Probabilistic Range: {criticalPower.low}W - {criticalPower.high}W
                                </p>
                                <p className="text-sm text-muted" style={{ marginTop: '2px' }}>
                                    W' (Anaerobic Capacity): {(criticalPower.w_prime / 1000).toFixed(1)} kJ
                                </p>
                            </>
                        ) : (
                            <p className="text-muted">Need max efforts (3min & 20min) to detect.</p>
                        )}
                    </div>

                    {/* Critical Heart Rate (CHR) */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted">Critical Heart Rate</span>
                                <div title="Theoretical HR at Lactate Threshold/CP" style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <Heart size={20} color="var(--accent-danger)" />
                        </div>
                        {criticalHeartRate ? (
                            <>
                                <p className="text-xl">{criticalHeartRate.chr} bpm</p>
                                <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                                    H' (Capacity &gt; Threshold): {criticalHeartRate.h_prime} beats
                                </p>
                            </>
                        ) : (
                            <p className="text-muted">Need max efforts to detect.</p>
                        )}
                    </div>

                    {/* Estimated FTP */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted">FTP derived from FTP Test-like sessions</span>
                                <div title="95% of best 20min power" style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <TrendingUp size={20} color="var(--accent-primary)" />
                        </div>
                        <p className="text-xl">{currentUser?.profile.ftp} W</p>
                        <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                            Current Setting
                        </p>
                        <button
                            onClick={handleEstimateFtp}
                            className={styles.estimateBtn}
                            style={{
                                marginTop: 'var(--space-md)',
                                padding: '6px 12px',
                                fontSize: '0.875rem',
                                background: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}
                        >
                            <Calculator size={14} /> Update
                        </button>
                        {ftpSuggestion && (
                            <div style={{ marginTop: 'var(--space-md)', borderTop: '1px dashed var(--border-color)', paddingTop: 'var(--space-sm)' }}>
                                <p className="text-sm text-muted">Suggestion: {ftpSuggestion.reason}</p>
                                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                                    <button onClick={applyFtpSuggestion} className={styles.estimateBtn} style={{ padding: '6px 12px' }}>
                                        Apply suggested FTP ({ftpSuggestion.suggestedUpdate} W)
                                    </button>
                                    <button onClick={() => setFtpSuggestion(null)} className="text-muted" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Session Derived FTP */}
                    <div className="card">
                        <div className="flex-center" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-md)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="text-muted" style={{ fontSize: '0.85rem' }}>FTP derived from Interval Sessions</span>
                                <div title="Estimated from sustained intervals (>=8m) in the last 40% of long rides (>1h, >70 TSS) with <4% cardiac drift" style={{ cursor: 'help', fontSize: '0.8em', opacity: 0.7 }}>ℹ️</div>
                            </div>
                            <Zap size={20} color="#eab308" />
                        </div>
                        {sessionDerivedFtp ? (
                            <>
                                <p className="text-xl">{sessionDerivedFtp.low}W - {sessionDerivedFtp.high}W</p>
                                <p className="text-sm text-muted" style={{ marginTop: 'var(--space-sm)' }}>
                                    Probability Range (95-100%)
                                </p>
                            </>
                        ) : (
                            <p className="text-muted" style={{ fontSize: '0.85rem' }}>No stable late-workout intervals detected yet.</p>
                        )}
                    </div>

                    {/* Time in Zones Chart */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Time in Zones (Last 4 Weeks)</h3>
                            <span className="text-sm text-muted">Minutes spent in each intensity zone</span>
                        </div>
                        <div style={{ height: '250px', width: '100%' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={zoneData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                    <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                        itemStyle={{ color: 'var(--text-primary)' }}
                                        cursor={{ fill: 'var(--bg-tertiary)' }}
                                    />
                                    <Bar dataKey="time" radius={[4, 4, 0, 0]}>
                                        {zoneData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.color} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Heart Rate Time in Zones Chart */}
                    <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <div className={styles.cardHeader}>
                            <h3 className="text-lg">Heart Rate Zones (Last 4 Weeks)</h3>
                            <span className="text-sm text-muted">Minutes spent in each HR zone</span>
                        </div>
                        <div style={{ height: '250px', width: '100%' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={hrZoneData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                                    <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                                        itemStyle={{ color: 'var(--text-primary)' }}
                                        cursor={{ fill: 'var(--bg-tertiary)' }}
                                    />
                                    <Bar dataKey="time" radius={[4, 4, 0, 0]}>
                                        {hrZoneData.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.color} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                </div>
            )}

            <Modal
                isOpen={isFtpModalOpen}
                onClose={() => setIsFtpModalOpen(false)}
                title="FTP Estimation"
            >
                <div style={{ padding: 'var(--space-md)' }}>
                    <p style={{ marginBottom: 'var(--space-lg)', lineHeight: '1.5' }}>{ftpMessage}</p>
                    {estimatedFtp && (
                        <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setIsFtpModalOpen(false)}
                                style={{ padding: '8px 16px', borderRadius: '4px', background: 'transparent', border: '1px solid var(--border-color)', cursor: 'pointer', color: 'var(--text-primary)' }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmFtpUpdate}
                                style={{ padding: '8px 16px', borderRadius: '4px', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                            >
                                Accept {estimatedFtp}W
                            </button>
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
};

export default Analysis;
