import React, { useState, useEffect } from 'react';
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, format, isSameMonth, isSameDay, addMonths, subMonths, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { useUser } from '../context/UserContext';
import { db, getLocalDayKey } from '../utils/db';
import { identifyImprovements } from '../utils/analysis';
import Modal from '../components/Modal';
import DailyMetricsForm from '../components/DailyMetricsForm';
import RideDetailsModal from '../components/RideDetailsModal';
import WeeklyStats from '../components/WeeklyStats';
import WorkoutPill from '../components/WorkoutPill';
import StarWeekReportModal from '../components/StarWeekReportModal';
import styles from './Calendar.module.css';

const Calendar = () => {
    const { currentUser } = useUser();
    const [currentDate, setCurrentDate] = useState(new Date());
    const [workouts, setWorkouts] = useState([]);
    const [metrics, setMetrics] = useState([]);
    const [improvements, setImprovements] = useState({});
    const [starDays, setStarDays] = useState(new Set()); // Days that complete a Star Period
    const [starReportDate, setStarReportDate] = useState(null);
    const [starReportReturnDate, setStarReportReturnDate] = useState(null);

    // Modal State
    const [modalConfig, setModalConfig] = useState({
        isOpen: false,
        type: null,
        data: null,
        title: ''
    });

    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

    const fetchWorkouts = async () => {
        if (!currentUser) return;
        const allWorkouts = await db.getWorkouts(currentUser.id);
        const allMetrics = await db.getMetrics(currentUser.id, '1970-01-01', '2100-01-01');

        setWorkouts(allWorkouts);
        setMetrics(allMetrics);

        // Calculate Improvements
        const improvementsMap = identifyImprovements(allWorkouts);
        setImprovements(improvementsMap);
    };

    // Calculate Star Periods (Rolling 7-day window)
    useEffect(() => {
        if (workouts.length === 0) return;

        const stars = new Set();

        calendarDays.forEach(day => {
            const windowStart = subDays(day, 6); // 7 day window inclusive

            // Count high-feeling workouts in this window
            const validWorkouts = workouts.filter(w => {
                const wDate = new Date(w.date);
                // Check if date is within window [windowStart, day]
                // Reset times for accurate comparison
                const d = new Date(day); d.setHours(23, 59, 59, 999);
                const start = new Date(windowStart); start.setHours(0, 0, 0, 0);
                const wTime = wDate.getTime();

                return wTime >= start.getTime() && wTime <= d.getTime();
            });

            // Check condition: >= 3 workouts with feeling >= 8
            const highFeelingCount = validWorkouts.filter(w => (w.feeling_strength || 0) >= 8).length;

            if (highFeelingCount >= 3) {
                stars.add(day.toDateString());
            }
        });

        setStarDays(stars);

    }, [workouts, currentDate]); // Recalculate when data or month view changes

    useEffect(() => {
        fetchWorkouts();
    }, [currentDate, modalConfig.isOpen, currentUser]);

    const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));
    const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));

    const getWorkoutsForDay = (day) => {
        const dayKey = getLocalDayKey(day);
        return workouts.filter(w => getLocalDayKey(w.date) === dayKey);
    };

    const getMetricsForDay = (day) => {
        const dayKey = getLocalDayKey(day);
        return metrics.find(m => m.date === dayKey);
    };

    const handleDayClick = (day) => {
        setModalConfig({
            isOpen: true,
            type: 'metrics',
            data: day,
            title: `Log for ${format(day, 'MMM d, yyyy')}`
        });
    };

    const handleStarClick = (e, day) => {
        e.stopPropagation();
        setStarReportDate(day.toISOString());
    };

    const handleWorkoutClick = (e, workout) => {
        e.stopPropagation();
        setModalConfig({
            isOpen: true,
            type: 'workout',
            data: workout,
            title: workout.title || 'Workout Details'
        });
    };

    const handleOpenWorkoutFromStarReport = (workoutId) => {
        const workout = workouts.find(w => w.id === workoutId);
        if (!workout) return;

        setStarReportReturnDate(starReportDate);
        setStarReportDate(null);
        setModalConfig({
            isOpen: true,
            type: 'workout',
            data: workout,
            title: workout.title || 'Workout Details'
        });
    };

    const closeModal = () => {
        const shouldReturnToStarReport = modalConfig.type === 'workout' && !!starReportReturnDate;

        setModalConfig({ ...modalConfig, isOpen: false });

        if (shouldReturnToStarReport) {
            setStarReportDate(starReportReturnDate);
            setStarReportReturnDate(null);
        }
    };

    if (!currentUser) return null;

    return (
        <div className={styles.wrapper}>
            {/* Main Calendar Area */}
            <div className={styles.container}>
                <header className={styles.header}>
                    <div className={styles.monthNav}>
                        <button onClick={prevMonth} className={styles.navBtn}><ChevronLeft size={24} color="var(--text-primary)" /></button>
                        <h2 className="text-xl">{format(currentDate, 'MMMM yyyy')}</h2>
                        <button onClick={nextMonth} className={styles.navBtn}><ChevronRight size={24} color="var(--text-primary)" /></button>
                    </div>
                </header>

                <div className={styles.grid}>
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                        <div key={day} className={styles.dayHeader}>{day}</div>
                    ))}
                    <div className={styles.dayHeader}>Summary</div>

                    {calendarDays.map((day, index) => {
                        const dayWorkouts = getWorkoutsForDay(day);
                        const dayMetrics = getMetricsForDay(day);
                        const isCurrentMonth = isSameMonth(day, monthStart);
                        const isToday = isSameDay(day, new Date());

                        const isLastDayOfWeek = index % 7 === 6;
                        const weekDays = isLastDayOfWeek ? calendarDays.slice(index - 6, index + 1) : [];

                        return (
                            <React.Fragment key={day.toString()}>
                                <div
                                key={day.toString()}
                                className={`${styles.dayCell} ${!isCurrentMonth ? styles.disabled : ''} ${isToday ? styles.today : ''}`}
                                onClick={() => handleDayClick(day)}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div className={styles.dayNumber}>{format(day, 'd')}</div>
                                    <div style={{ display: 'flex', gap: '4px' }}>
                                        {starDays.has(day.toDateString()) && (
                                            <div onClick={(e) => handleStarClick(e, day)} style={{ cursor: 'pointer' }}>
                                                <Star size={14} fill="#FFD700" color="#FFD700" title="Star Period! Click for Report" />
                                            </div>
                                        )}
                                        {dayMetrics && (
                                            <div title={`Sleep: ${dayMetrics.sleepHours}h`} style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--accent-secondary)', marginTop: '4px' }}></div>
                                        )}
                                    </div>
                                </div>

                                <div className={styles.workoutList}>
                                    {dayWorkouts.map(w => (
                                        <WorkoutPill
                                            key={w.id}
                                            workout={w}
                                            onClick={(e) => handleWorkoutClick(e, w)}
                                            badges={improvements[w.id]} // Pass badges
                                        />
                                    ))}
                                </div>
                            </div>
                            {isLastDayOfWeek && (
                                <WeeklyStats
                                    weekIndex={Math.floor(index / 7)}
                                    weekDays={weekDays}
                                    workouts={workouts}
                                    metrics={metrics}
                                    currentUser={currentUser}
                                />
                            )}
                        </React.Fragment>
                        );
                    })}
                </div>

                <Modal
                    isOpen={modalConfig.isOpen}
                    onClose={closeModal}
                    title={modalConfig.title}
                >
                    {modalConfig.type === 'metrics' && (
                        <DailyMetricsForm
                            date={modalConfig.data}
                            onSave={() => {
                                closeModal();
                                fetchWorkouts();
                            }}
                        />
                    )}
                    {modalConfig.type === 'workout' && (
                        <RideDetailsModal workout={modalConfig.data} />
                    )}
                </Modal>

                <StarWeekReportModal
                    isOpen={!!starReportDate}
                    onClose={() => {
                        setStarReportDate(null);
                        setStarReportReturnDate(null);
                    }}
                    endDate={starReportDate}
                    workouts={workouts}
                    metrics={metrics}
                    currentUser={currentUser}
                    onOpenWorkout={handleOpenWorkoutFromStarReport}
                />
            </div>
        </div>
    );
};

export default Calendar;
