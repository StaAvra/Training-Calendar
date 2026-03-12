import React, { useState, useEffect } from 'react';
import { useUser } from '../context/UserContext';
import { db } from '../utils/db';
import { fetchGarminSleepData } from '../utils/garminApi';
import { getLocalDayKey } from '../utils/db';
import { Moon, Heart, Activity, Watch } from 'lucide-react';
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
    const [garminConnected, setGarminConnected] = useState(false);
    const [garminLoading, setGarminLoading] = useState(false);
    const [garminStatus, setGarminStatus] = useState('');

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
                
                // Check Garmin connection
                const gc = await db.getSettings('garmin_connected');
                setGarminConnected(!!gc);
            } catch (e) {
                console.error("Error loading metrics", e);
            } finally {
                setLoading(false);
            }
        };
        loadMetrics();
    }, [currentUser, date]);

    const handleGarminFetch = async () => {
        if (!date) return;
        setGarminLoading(true);
        setGarminStatus('');
        try {
            const dateStr = getLocalDayKey(date);
            if (!dateStr) throw new Error('Invalid date');
            
            const data = await fetchGarminSleepData(dateStr);
            
            if (!data.found) {
                setGarminStatus('No Garmin data for this date.');
                return;
            }
            
            setMetrics(prev => ({
                ...prev,
                sleepHours: data.sleepHours ?? prev.sleepHours,
                sleepQuality: data.sleepQuality ?? prev.sleepQuality,
                hrv: data.avgHrv ?? prev.hrv
            }));
            
            const parts = [];
            if (data.sleepHours) parts.push(`Sleep: ${data.sleepHours}h`);
            if (data.sleepQuality) parts.push(`Quality: ${data.sleepQuality}`);
            if (data.avgHrv) parts.push(`HRV: ${data.avgHrv}ms`);
            if (data.restingHr) parts.push(`RHR: ${data.restingHr}bpm`);
            
            setGarminStatus(`Loaded: ${parts.join(', ')}`);
        } catch (err) {
            console.error('Garmin fetch error:', err);
            setGarminStatus(err.message);
        } finally {
            setGarminLoading(false);
        }
    };

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

            {garminConnected && (
                <div style={{ marginBottom: '12px' }}>
                    <button
                        type="button"
                        onClick={handleGarminFetch}
                        disabled={garminLoading}
                        style={{
                            width: '100%',
                            padding: '8px 16px',
                            background: '#007dc3',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: garminLoading ? 'wait' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            fontSize: '14px'
                        }}
                    >
                        <Watch size={16} />
                        {garminLoading ? 'Fetching...' : 'Fetch from Garmin'}
                    </button>
                    {garminStatus && (
                        <div style={{
                            marginTop: '6px',
                            fontSize: '12px',
                            color: garminStatus.startsWith('Loaded') ? '#27ae60' : '#e74c3c',
                            textAlign: 'center'
                        }}>
                            {garminStatus}
                        </div>
                    )}
                </div>
            )}

            <button type="submit" className={styles.saveBtn}>Save Metrics</button>
        </form>
    );
};

export default DailyMetricsForm;
