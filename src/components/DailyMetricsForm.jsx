import React, { useState, useEffect } from 'react';
import { useUser } from '../context/UserContext';
import { db } from '../utils/db';
import { Moon, Heart, Activity } from 'lucide-react';
import styles from '../pages/Profile.module.css';

const DailyMetricsForm = ({ date, onSave }) => {
    const { currentUser } = useUser();
    const [metrics, setMetrics] = useState({
        sleepHours: 7,
        sleepQuality: 80,
        hrv: 50,
        feeling: 3
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadMetrics = async () => {
            if (!currentUser || !date) return;
            setLoading(true);
            try {
                const existing = await db.getMetric(currentUser.id, date);
                if (existing) {
                    setMetrics({
                        sleepHours: existing.sleepHours || 7,
                        sleepQuality: existing.sleepQuality || 80,
                        hrv: existing.hrv || 50,
                        feeling: existing.feeling || 3
                    });
                }
            } catch (e) {
                console.error("Error loading metrics", e);
            } finally {
                setLoading(false);
            }
        };
        loadMetrics();
    }, [currentUser, date]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setMetrics(prev => ({
            ...prev,
            [name]: Number(value)
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!currentUser) return;
        await db.saveMetric(currentUser.id, date, metrics);
        onSave();
    };

    if (loading) return <div style={{ padding: '20px', textAlign: 'center' }}>Loading metrics...</div>;

    return (
        <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.inputGroup}>
                <label>Sleep Duration</label>
                <div className={styles.inputWrapper}>
                    <Moon size={16} />
                    <input
                        type="number"
                        name="sleepHours"
                        step="0.5"
                        value={metrics.sleepHours}
                        onChange={handleChange}
                    />
                    <span>hrs</span>
                </div>
            </div>

            <div className={styles.inputGroup}>
                <label>Sleep Quality (1-100)</label>
                <div className={styles.inputWrapper}>
                    <Activity size={16} />
                    <input
                        type="number"
                        name="sleepQuality"
                        min="1"
                        max="100"
                        value={metrics.sleepQuality}
                        onChange={handleChange}
                    />
                    <span>%</span>
                </div>
            </div>

            <div className={styles.inputGroup}>
                <label>HRV (rMSSD)</label>
                <div className={styles.inputWrapper}>
                    <Heart size={16} />
                    <input
                        type="number"
                        name="hrv"
                        value={metrics.hrv}
                        onChange={handleChange}
                    />
                    <span>ms</span>
                </div>
            </div>

            <button type="submit" className={styles.saveBtn}>Save Metrics</button>
        </form>
    );
};

export default DailyMetricsForm;
