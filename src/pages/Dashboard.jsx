import React, { useEffect, useState } from 'react';
import { startOfWeek, endOfWeek, subDays, isWithinInterval, startOfDay } from 'date-fns';
import { useUser } from '../context/UserContext';
import { db } from '../utils/db';
import { calculateCriticalPower, calculatePhenotype, calculateSessionDerivedFtp } from '../utils/analysis';
import FileDropzone from '../components/FileDropzone';
import WorkoutPill from '../components/WorkoutPill';
import Modal from '../components/Modal';
import RideDetailsModal from '../components/RideDetailsModal';
import { Activity, Clock, Zap } from 'lucide-react';

const Dashboard = () => {
    const { currentUser } = useUser();
    const [workouts, setWorkouts] = useState([]);
    const [stats, setStats] = useState({ count: 0, distance: 0, duration: 0 });
    const [performance, setPerformance] = useState({ cp: null, ae: null, phenotype: null, sessionDerivedFtp: null });
    const [selectedWorkout, setSelectedWorkout] = useState(null);

    const loadData = async () => {
        if (!currentUser) return;
        const data = await db.getWorkouts(currentUser.id);
        const sorted = data.sort((a, b) => new Date(b.date) - new Date(a.date));
        setWorkouts(sorted);

        // 1. Calculate Weekly Stats (Last 7 Days)
        const sevenDaysAgo = subDays(new Date(), 7);
        const weeklyWorkouts = sorted.filter(w => new Date(w.date) >= sevenDaysAgo);

        const totalDist = weeklyWorkouts.reduce((acc, curr) => acc + (curr.total_distance || 0), 0);
        const totalTime = weeklyWorkouts.reduce((acc, curr) => acc + (curr.total_elapsed_time || 0), 0);

        setStats({
            count: weeklyWorkouts.length,
            distance: (totalDist / 1000).toFixed(1), // km
            duration: (totalTime / 3600).toFixed(1) // hours
        });

        // 2. Performance Metrics (Last 6 Weeks)
        const sixWeeksAgo = startOfDay(subDays(new Date(), 42));
        const recentWorkouts = sorted.filter(w => new Date(w.date) >= sixWeeksAgo);

        // CP Logic
        const curveBests = {
            duration_5s: 0, duration_1m: 0, duration_5m: 0, duration_20m: 0, duration_3m: 0 // Adding 3m for CP
        };
        recentWorkouts.forEach(w => {
            if (w.power_curve) {
                Object.keys(curveBests).forEach(k => {
                    if (w.power_curve[k] > curveBests[k]) curveBests[k] = w.power_curve[k];
                });
            }
        });

        const cp = calculateCriticalPower(curveBests);
        const phenotype = calculatePhenotype(curveBests, currentUser.profile?.weight || 70);
        const sessionDerivedFtp = calculateSessionDerivedFtp(recentWorkouts);

        // AE Logic (NP / HR for qualifying rides) - Show most recent
        const qualifyingRides = recentWorkouts
            .filter(w => {
                const ifVal = w.intensity_factor || ((w.normalized_power || w.avg_power) / (currentUser.profile?.ftp || 250));
                return ifVal <= 0.75 && (w.total_elapsed_time / 60) >= 30 && w.avg_heart_rate > 0;
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date)); // Sort by date descending

        const ae = qualifyingRides.length > 0
            ? ((qualifyingRides[0].normalized_power || qualifyingRides[0].avg_power) / qualifyingRides[0].avg_heart_rate).toFixed(2)
            : null;

        setPerformance({ cp, ae, phenotype, sessionDerivedFtp });
    };

    useEffect(() => {
        loadData();
    }, [currentUser]);

    if (!currentUser) return <div className="container">Loading user...</div>;

    return (
        <div className="container">
            <header style={{ marginBottom: 'var(--space-2xl)' }}>
                <h1 className="text-xl">Welcome back, {currentUser.name}</h1>
                <p className="text-muted">Here is your training summary (Last 7 Days).</p>
            </header>

            {/* Summary Widgets */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-lg)', marginBottom: 'var(--space-2xl)' }}>
                <div className="card">
                    <div className="flex-center" style={{ gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
                        <Activity size={20} color="var(--accent-primary)" />
                        <span className="text-muted">Weekly Rides</span>
                    </div>
                    <p className="text-2xl">{stats.count}</p>
                </div>
                <div className="card">
                    <div className="flex-center" style={{ gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
                        <Zap size={20} color="var(--accent-secondary)" />
                        <span className="text-muted">Weekly Distance</span>
                    </div>
                    <p className="text-2xl">{stats.distance} <span className="text-sm text-muted">km</span></p>
                </div>
                <div className="card">
                    <div className="flex-center" style={{ gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
                        <Clock size={20} color="var(--accent-tertiary)" />
                        <span className="text-muted">Weekly Duration</span>
                    </div>
                    <p className="text-2xl">{stats.duration} <span className="text-sm text-muted">hrs</span></p>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-xl)' }}>
                {/* Main Content Area */}
                <div>
                    <div className="card" style={{ marginBottom: 'var(--space-xl)' }}>
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Quick Upload</h3>
                        <FileDropzone onUploadComplete={loadData} />
                    </div>

                    <div>
                        <h3 className="text-lg" style={{ marginBottom: 'var(--space-md)' }}>Recent Activity</h3>
                        {workouts.length === 0 ? (
                            <p className="text-muted">No rides uploaded yet.</p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                                {workouts.slice(0, 5).map(workout => (
                                    <div key={workout.id} className="card" style={{ padding: 'var(--space-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <div>
                                            <p className="text-sm text-muted" style={{ marginBottom: 4 }}>{new Date(workout.date).toLocaleDateString()}</p>
                                            <WorkoutPill
                                                workout={workout}
                                                onClick={() => setSelectedWorkout(workout)}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Sidebar / Performance Status */}
                <div>
                    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                        <div>
                            <h3 className="text-sm text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-xs)' }}>Current FTP</h3>
                            <p className="text-2xl" style={{ fontWeight: 'bold', color: 'var(--accent-primary)' }}>{currentUser.profile?.ftp || 250}W</p>

                            {performance.sessionDerivedFtp && (
                                <div style={{ marginTop: '4px' }}>
                                    <span className="text-xs text-muted">Interval Derived:</span>
                                    <span className="text-sm" style={{ marginLeft: 4, color: '#eab308', fontWeight: 600 }}>
                                        {performance.sessionDerivedFtp.low}W - {performance.sessionDerivedFtp.high}W
                                    </span>
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-sm)', borderTop: '1px solid var(--border-color)', paddingTop: 'var(--space-xs)' }}>
                                <div>
                                    <span className="text-xs text-muted">CP:</span>
                                    <span className="text-sm" style={{ marginLeft: 4 }}>{performance.cp?.cp ? `${performance.cp.cp}W` : '-'}</span>
                                </div>
                                <div>
                                    <span className="text-xs text-muted">AE:</span>
                                    <span className="text-sm" style={{ marginLeft: 4 }}>{performance.ae || '-'}</span>
                                </div>
                            </div>
                        </div>

                        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 'var(--space-md)' }}>
                            <h3 className="text-sm text-muted" style={{ textTransform: 'uppercase', marginBottom: 'var(--space-xs)' }}>Athlete Strengths</h3>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                {performance.phenotype?.strengths?.map(s => (
                                    <span key={s} style={{ fontSize: '0.8rem', background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '2px 8px', borderRadius: '12px', fontWeight: 600 }}>
                                        {s}
                                    </span>
                                )) || <span className="text-xs text-muted">Calculating...</span>}
                            </div>
                            <p className="text-xs text-muted" style={{ marginTop: ' var(--space-xs)' }}>Type: {performance.phenotype?.type || 'All-Rounder'}</p>
                        </div>
                    </div>
                </div>
            </div>

            <Modal
                isOpen={!!selectedWorkout}
                onClose={() => setSelectedWorkout(null)}
                title={selectedWorkout?.title || 'Details'}
            >
                <RideDetailsModal workout={selectedWorkout} />
            </Modal>

        </div>
    );
};

export default Dashboard;
