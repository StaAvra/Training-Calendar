import React from 'react';
import { Activity } from 'lucide-react';
import styles from './WorkoutPill.module.css';

const WorkoutPill = ({ workout, onClick, badges }) => {
    // Badges: [ { label, delta, value }, ... ]
    const hasPowerBest = badges && badges.some(b => b.label.includes('Power'));
    const hasEfBest = badges && badges.some(b => b.label.includes('Aerobic Efficiency'));

    return (
        <div
            className={`${styles.workoutPill} ${hasPowerBest ? styles.goldBorder : ''} ${hasEfBest ? styles.greenBorder : ''}`}
            onClick={(e) => onClick && onClick(e, workout)}
            title={badges ? badges.map(b => b.label).join(', ') : ''}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Activity size={14} />
                <span className={styles.timeProp}>{(workout.total_elapsed_time / 60).toFixed(0)}m</span>
            </div>
            {workout.avg_power && <span className={styles.pillPower}>{Math.round(workout.avg_power)}W</span>}

            {(hasPowerBest || hasEfBest) && (
                <div className={styles.badges}>
                    {hasPowerBest && <div className={styles.badgePower} title="New Power Record!" />}
                    {hasEfBest && <div className={styles.badgeEf} title="Efficiency Improvement!" />}
                </div>
            )}
        </div>
    );
};

export default WorkoutPill;
