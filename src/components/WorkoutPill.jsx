import React from 'react';
import { Activity } from 'lucide-react';
import styles from './WorkoutPill.module.css';

const WorkoutPill = ({ workout, onClick, badges, draggable = false, onDragStart }) => {
    // Badges: [ { label, delta, value }, ... ]
    const hasPowerBest = badges && badges.some(b => b.label.includes('Power'));
    const hasEfBest = badges && badges.some(b => b.label.includes('Aerobic Efficiency'));
    const isLinked = !!workout?.linked_actual_workout_id;
    const targetDisplay = workout?.structured_target_avg || workout?.avg_power;
    const intervalSummary = workout?.structured_reps && workout?.structured_interval_mins
        ? `${workout.structured_reps}x${workout.structured_interval_mins}m / ${workout.structured_rest_mins || 0}m @ ${workout.structured_power_low || '-'}-${workout.structured_power_high || '-'}W`
        : null;

    return (
        <div
            className={`${styles.workoutPill} ${hasPowerBest ? styles.goldBorder : ''} ${hasEfBest ? styles.greenBorder : ''} ${isLinked ? styles.linkedBorder : ''} ${draggable ? styles.draggablePill : ''}`}
            onClick={(e) => onClick && onClick(e, workout)}
            title={draggable ? 'Drag to reschedule' : (isLinked ? 'Linked to plan' : (badges ? badges.map(b => b.label).join(', ') : ''))}
            draggable={draggable}
            onDragStart={onDragStart}
        >
            <div className={styles.leftBlock}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Activity size={14} />
                    <span className={styles.timeProp}>{(workout.total_elapsed_time / 60).toFixed(0)}m</span>
                </div>
                {intervalSummary && <div className={styles.intervalSummary}>{intervalSummary}</div>}
                {draggable && <div className={styles.dragHint}>Drag to reschedule</div>}
            </div>
            {targetDisplay && <span className={styles.pillPower}>{Math.round(targetDisplay)}W</span>}

            {(hasPowerBest || hasEfBest || isLinked) && (
                <div className={styles.badges}>
                    {hasPowerBest && <div className={styles.badgePower} title="New Power Record!" />}
                    {hasEfBest && <div className={styles.badgeEf} title="Efficiency Improvement!" />}
                    {isLinked && <div className={styles.badgeLinked} title="Linked to plan" />}
                </div>
            )}
        </div>
    );
};

export default WorkoutPill;
