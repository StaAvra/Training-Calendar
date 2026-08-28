import React, { useState, useEffect, useMemo } from 'react';
import { startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, format, isSameMonth, isSameDay, addMonths, subMonths, subDays, startOfDay } from 'date-fns';
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
    const [constraints, setConstraints] = useState([]);
    const [improvements, setImprovements] = useState({});
    const [starDays, setStarDays] = useState(new Set()); // Days that complete a Star Period
    const [starReportDate, setStarReportDate] = useState(null);
    const [starReportReturnDate, setStarReportReturnDate] = useState(null);
    const [dragOverDayKey, setDragOverDayKey] = useState(null);

    // Modal State
    const [modalConfig, setModalConfig] = useState({
        isOpen: false,
        type: null,
        data: null,
        title: ''
    });

    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
    const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });

    const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

    const fetchWorkouts = async () => {
        if (!currentUser) return;
        const allWorkouts = await db.getWorkouts(currentUser.id);
        const allMetrics = await db.getMetrics(currentUser.id, '1970-01-01', '2100-01-01');
        const allConstraints = await db.getConstraints(currentUser.id);

        setWorkouts(allWorkouts);
        setMetrics(allMetrics);
        setConstraints(allConstraints || []);

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

    useEffect(() => {
        if (!currentUser) return undefined;

        const onDataUpdated = (event) => {
            const eventUserId = event?.detail?.userId;
            if (eventUserId && Number(eventUserId) !== Number(currentUser.id)) return;
            fetchWorkouts();
        };

        window.addEventListener('training-data-updated', onDataUpdated);
        return () => window.removeEventListener('training-data-updated', onDataUpdated);
    }, [currentUser]);

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

    const getConstraintsForDay = (day) => {
        const dayKey = getLocalDayKey(day);
        return (constraints || []).filter((constraint) => {
            const start = getLocalDayKey(constraint.startDate);
            const end = getLocalDayKey(constraint.endDate || constraint.startDate);
            if (!start || !end || !dayKey) return false;
            return dayKey >= start && dayKey <= end;
        });
    };

    const formatDayKey = (dayKey) => {
        if (!dayKey || typeof dayKey !== 'string') return '';
        const [year, month, day] = dayKey.split('-').map(Number);
        if (!year || !month || !day) return dayKey;
        return format(new Date(year, month - 1, day), 'MMM d');
    };

    const monthConstraintEvents = useMemo(() => {
        const monthStartKey = getLocalDayKey(monthStart);
        const monthEndKey = getLocalDayKey(monthEnd);
        if (!monthStartKey || !monthEndKey) return [];

        return (constraints || [])
            .filter((constraint) => {
                const startKey = getLocalDayKey(constraint.startDate);
                const endKey = getLocalDayKey(constraint.endDate || constraint.startDate);
                if (!startKey || !endKey) return false;
                return startKey <= monthEndKey && endKey >= monthStartKey;
            })
            .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
            .map((constraint) => {
                const startKey = getLocalDayKey(constraint.startDate);
                const endKey = getLocalDayKey(constraint.endDate || constraint.startDate);
                const precedence = String(constraint.precedence || 'soft').toLowerCase();
                const label = constraint.title || constraint.type || 'Constraint';
                const startLabel = formatDayKey(startKey);
                const endLabel = formatDayKey(endKey);
                const rangeLabel = startKey === endKey ? startLabel : `${startLabel} - ${endLabel}`;

                return {
                    id: constraint.id,
                    label,
                    precedence,
                    rangeLabel,
                };
            });
    }, [constraints, monthStart, monthEnd]);

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

    const isReschedulableRide = (workout) => {
        if (!workout) return false;
        const today = startOfDay(new Date());
        const rideDay = startOfDay(new Date(workout.date));
        const completionStatus = workout.completion_status || (workout.completed ? 'completed' : 'planned');
        const isNotCompleted = completionStatus !== 'completed';

        // Rescheduling is allowed for incomplete rides outside the current day.
        return isNotCompleted && !isSameDay(rideDay, today);
    };

    const handleWorkoutDragStart = (e, workout) => {
        if (!isReschedulableRide(workout)) return;
        e.dataTransfer.setData('application/x-workout-id', String(workout.id));
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDayDragOver = (e, day) => {
        e.preventDefault();
        const dayKey = getLocalDayKey(day);
        setDragOverDayKey(dayKey);
    };

    const handleDayDragLeave = (day) => {
        const dayKey = getLocalDayKey(day);
        if (dragOverDayKey === dayKey) setDragOverDayKey(null);
    };

    const handleDayDrop = async (e, day) => {
        e.preventDefault();
        setDragOverDayKey(null);

        const idRaw = e.dataTransfer.getData('application/x-workout-id');
        const workoutId = Number(idRaw);
        if (!workoutId || !currentUser) return;

        const workout = workouts.find(w => w.id === workoutId);
        if (!isReschedulableRide(workout)) return;

        const today = startOfDay(new Date());
        const target = startOfDay(day);
        const source = startOfDay(new Date(workout.date));

        // Past incomplete rides can move to today or the future.
        // Future incomplete rides keep existing behavior (future-to-future only).
        if (source < today) {
            if (target < today) return;
        } else if (source > today) {
            if (target <= today) return;
        }

        const sourceDate = new Date(workout.date);
        const movedDate = new Date(target);
        movedDate.setHours(sourceDate.getHours(), sourceDate.getMinutes(), sourceDate.getSeconds(), sourceDate.getMilliseconds());

        await db.updateWorkout(workout.id, { date: movedDate.toISOString() });
        await fetchWorkouts();
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

                    {monthConstraintEvents.length > 0 && (
                        <div style={{ marginTop: '0.75rem' }}>
                            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                                Month Planning Events
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                                {monthConstraintEvents.map((item) => {
                                    const isHard = item.precedence === 'hard';
                                    return (
                                        <div
                                            key={`month-constraint-${item.id}`}
                                            style={{
                                                fontSize: '0.74rem',
                                                borderRadius: '999px',
                                                padding: '0.2rem 0.55rem',
                                                border: `1px solid ${isHard ? 'rgba(239, 68, 68, 0.7)' : 'rgba(59, 130, 246, 0.7)'}`,
                                                background: isHard ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)',
                                                color: isHard ? '#fecaca' : '#bfdbfe'
                                            }}
                                            title={`${item.label} (${item.precedence}) ${item.rangeLabel}`}
                                        >
                                            {isHard ? 'Block' : 'Reduce'} {item.label} · {item.rangeLabel}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </header>

                <div className={styles.grid}>
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                        <div key={day} className={styles.dayHeader}>{day}</div>
                    ))}
                    <div className={styles.dayHeader}>Summary</div>

                    {calendarDays.map((day, index) => {
                        const dayWorkouts = getWorkoutsForDay(day);
                        const dayMetrics = getMetricsForDay(day);
                        const dayConstraints = getConstraintsForDay(day);
                        const isCurrentMonth = isSameMonth(day, monthStart);
                        const isToday = isSameDay(day, new Date());

                        const isLastDayOfWeek = index % 7 === 6;
                        const weekDays = isLastDayOfWeek ? calendarDays.slice(index - 6, index + 1) : [];

                        return (
                            <React.Fragment key={day.toString()}>
                                <div
                                key={day.toString()}
                                className={`${styles.dayCell} ${!isCurrentMonth ? styles.disabled : ''} ${isToday ? styles.today : ''} ${dragOverDayKey === getLocalDayKey(day) ? styles.dragOver : ''}`}
                                onClick={() => handleDayClick(day)}
                                onDragOver={(e) => handleDayDragOver(e, day)}
                                onDragLeave={() => handleDayDragLeave(day)}
                                onDrop={(e) => handleDayDrop(e, day)}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div className={styles.dayNumber}>{format(day, 'd')}</div>
                                    <div style={{ display: 'flex', gap: '4px' }}>
                                        {dayConstraints.length > 0 && (
                                            <div
                                                title={dayConstraints.map(c => `${c.title || c.type} (${c.precedence || 'soft'})`).join(' | ')}
                                                style={{
                                                    minWidth: 14,
                                                    height: 14,
                                                    borderRadius: '50%',
                                                    backgroundColor: 'var(--accent-primary)',
                                                    color: 'white',
                                                    fontSize: '0.62rem',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center'
                                                }}
                                            >
                                                {dayConstraints.length}
                                            </div>
                                        )}
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
                                    {dayConstraints
                                        .slice()
                                        .sort((a, b) => {
                                            const aHard = String(a.precedence || '').toLowerCase() === 'hard' ? 1 : 0;
                                            const bHard = String(b.precedence || '').toLowerCase() === 'hard' ? 1 : 0;
                                            return bHard - aHard;
                                        })
                                        .map((constraint) => {
                                            const precedence = String(constraint.precedence || 'soft').toLowerCase();
                                            const isHard = precedence === 'hard';
                                            return (
                                                <div
                                                    key={`constraint-${constraint.id}`}
                                                    title={`${constraint.title || constraint.type} (${precedence})`}
                                                    style={{
                                                        fontSize: '0.67rem',
                                                        lineHeight: 1.2,
                                                        padding: '2px 6px',
                                                        borderRadius: '999px',
                                                        marginBottom: '4px',
                                                        border: `1px solid ${isHard ? 'rgba(239, 68, 68, 0.7)' : 'rgba(59, 130, 246, 0.7)'}`,
                                                        background: isHard ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                                        color: isHard ? '#fecaca' : '#bfdbfe',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap'
                                                    }}
                                                >
                                                    {isHard ? 'Block' : 'Reduce'}: {constraint.title || constraint.type}
                                                </div>
                                            );
                                        })}
                                    {dayWorkouts.map(w => (
                                        <WorkoutPill
                                            key={w.id}
                                            workout={w}
                                            onClick={(e) => handleWorkoutClick(e, w)}
                                            badges={improvements[w.id]} // Pass badges
                                            draggable={isReschedulableRide(w)}
                                            onDragStart={(e) => handleWorkoutDragStart(e, w)}
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
                        <RideDetailsModal workout={modalConfig.data} onClose={closeModal} />
                    )}
                </Modal>

                {constraints.length > 0 && (
                    <div style={{ marginTop: '0.9rem', padding: '0.7rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--bg-secondary)' }}>
                        <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', marginBottom: '0.45rem' }}>
                            Active Planning Events
                        </div>
                        <div style={{ display: 'grid', gap: '0.35rem' }}>
                            {constraints
                                .slice()
                                .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
                                .map((constraint) => (
                                    <div key={constraint.id} style={{ fontSize: '0.82rem' }}>
                                        <strong>{constraint.title || constraint.type}</strong> ({constraint.startDate} to {constraint.endDate || constraint.startDate}) [{constraint.precedence || 'soft'}]
                                    </div>
                                ))}
                        </div>
                    </div>
                )}

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
