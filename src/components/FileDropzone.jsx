import React, { useCallback, useState, useEffect } from 'react';
import { useUser } from '../context/UserContext';
import { Upload, FileCheck, CircleAlert, RefreshCw } from 'lucide-react';
import { parseFitFile } from '../utils/fitParser';
import { fetchStravaActivities, fetchStravaStreams } from '../utils/stravaApi';
import { db } from '../utils/db';
import styles from './FileDropzone.module.css';

const FileDropzone = ({ onUploadComplete }) => {
    const { currentUser } = useUser();
    const [isDragOver, setIsDragOver] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [status, setStatus] = useState(null); // 'success', 'error'
    const [message, setMessage] = useState('');
    const [isStravaConnected, setIsStravaConnected] = useState(false);

    useEffect(() => {
        db.getSettings('strava_access_token').then(t => {
            if (t) setIsStravaConnected(true);
        });
    }, []);

    const onDragOver = useCallback((e) => {
        e.preventDefault();
        setIsDragOver(true);
    }, []);

    const onDragLeave = useCallback((e) => {
        e.preventDefault();
        setIsDragOver(false);
    }, []);

    const processFile = async (file) => {
        if (!file.name.endsWith('.fit')) {
            setStatus('error');
            setMessage('Please upload a .fit file');
            return;
        }

        if (!currentUser) {
            setStatus('error');
            setMessage('No user selected.');
            return;
        }

        setIsProcessing(true);
        setStatus(null);
        setMessage(`Processing ${file.name}...`);

        try {
            const parsedData = await parseFitFile(file);

            // Basic validation
            if (!parsedData.start_time) {
                throw new Error("Could not parse start time from file");
            }

            const workout = {
                userId: currentUser.id,
                title: `Ride on ${new Date(parsedData.start_time).toLocaleDateString()}`,
                date: parsedData.start_time,
                ...parsedData,
                created_at: new Date().toISOString()
            };

            await db.addWorkout(workout);

            setStatus('success');
            setMessage('Import successful!');
            if (onUploadComplete) onUploadComplete();

        } catch (err) {
            console.error(err);
            setStatus('error');
            setMessage('Failed to parse file: ' + err.message);
        } finally {
            setIsProcessing(false);
            setIsDragOver(false);
        }
    };

    const onDrop = useCallback((e) => {
        e.preventDefault();
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            processFile(files[0]);
        }
    }, [currentUser]);

    const onFileSelect = (e) => {
        if (e.target.files && e.target.files.length > 0) {
            processFile(e.target.files[0]);
        }
    }

    const handleStravaSync = async () => {
        if (!currentUser) return;
        setIsProcessing(true);
        setStatus(null);
        setMessage('Fetching new Strava activities...');

        try {
            // Get last sync date or 7 days ago
            let lastSync = await db.getSettings('strava_last_sync');
            if (!lastSync) lastSync = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);

            const activities = await fetchStravaActivities(lastSync);
            
            if (!activities || activities.length === 0) {
                setStatus('success');
                setMessage('No new activities found.');
                // Update sync time anyway
                await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
                setIsProcessing(false);
                return;
            }

            let newCount = 0;
            const existingWorkouts = await db.getWorkouts(currentUser.id);

            for (const activity of activities) {
                // Check if already synced via strava OR fits the same date
                const isDuplicate = existingWorkouts.some(w => 
                    w.strava_id === activity.id || 
                    (new Date(w.start_time).getTime() === new Date(activity.start_date).getTime())
                );

                if (isDuplicate) continue;

                setMessage(`Fetching streams for ${activity.name}...`);
                const streamSet = await fetchStravaStreams(activity.id);

                if (streamSet && streamSet.length > 0) {
                    // Convert StreamSet (array of specific type objects) to Array of Objects (time, power, hr, etc)
                    const streamsData = {};
                    streamSet.forEach(s => { streamsData[s.type] = s.data; });
                    
                    const timeArr = streamsData.time || [];
                    const formattedStreams = [];
                    
                    for (let i = 0; i < timeArr.length; i++) {
                        formattedStreams.push({
                            time: timeArr[i],
                            power: streamsData.watts ? streamsData.watts[i] : null,
                            heart_rate: streamsData.heartrate ? streamsData.heartrate[i] : null,
                            cadence: streamsData.cadence ? streamsData.cadence[i] : null,
                            speed: streamsData.velocity_smooth ? streamsData.velocity_smooth[i] : null,
                            distance: streamsData.distance ? streamsData.distance[i] : null
                        });
                    }

                    // Calculate basic metrics from streams if missing
                    const avgPower = streamsData.watts ? streamsData.watts.reduce((a,b)=>a+b,0)/streamsData.watts.length : 0;
                    const maxPower = streamsData.watts ? Math.max(...streamsData.watts) : 0;

                    // Manual NP calc since we don't have fitParser context here easily without importing calculateNormalizedPower
                    // For now, save raw streams. fitParser logic handles metrics on load or we can extract NP logic later.
                    
                    const workout = {
                        userId: currentUser.id,
                        title: activity.name,
                        date: new Date(activity.start_date).toISOString(),
                        source: 'strava_api',
                        strava_id: activity.id,
                        imported_at: new Date().toISOString(),
                        start_time: new Date(activity.start_date).toISOString(),
                        total_elapsed_time: activity.elapsed_time,
                        total_distance: activity.distance,
                        avg_speed: activity.average_speed,
                        avg_power: activity.average_watts || avgPower || 0,
                        max_power: activity.max_watts || maxPower || 0,
                        avg_heart_rate: activity.average_heartrate || 0,
                        max_heart_rate: activity.max_heartrate || 0,
                        normalized_power: activity.weighted_average_watts || activity.average_watts, // Strava NP equivalent
                        total_work: activity.kilojoules ? activity.kilojoules * 1000 : 0, // Convert kJ to J
                        streams: formattedStreams
                    };

                    await db.addWorkout(workout);
                    newCount++;
                }
            }

            await db.saveSettings('strava_last_sync', Math.floor(Date.now() / 1000));
            setStatus('success');
            setMessage(`Successfully synced ${newCount} new activities!`);
            if (onUploadComplete && newCount > 0) onUploadComplete();

        } catch (err) {
            console.error("Strava Sync Error:", err);
            setStatus('error');
            setMessage(`Strava sync failed: ${err.message}`);
        } finally {
            setIsProcessing(false);
            setTimeout(() => {
                if (status === 'success') {
                    setStatus(null);
                    setMessage('');
                }
            }, 3000);
        }
    };

    return (
        <div
            className={`${styles.dropzone} ${isDragOver ? styles.dragOver : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div className={styles.content}>
                {isProcessing ? (
                    <div className="flex-center">
                        <div className={styles.spinner}></div>
                        <p>Processing...</p>
                    </div>
                ) : status === 'success' ? (
                    <div className={styles.success}>
                        <FileCheck size={48} color="var(--accent-secondary)" />
                        <p>{message}</p>
                        <button onClick={() => setStatus(null)} className={styles.resetBtn}>Upload another</button>
                    </div>
                ) : (
                    <>
                        <input type="file" id="fileInput" className={styles.hiddenInput} onChange={onFileSelect} accept=".fit" />
                        <label htmlFor="fileInput" className={styles.label}>
                            <Upload size={48} color="var(--text-secondary)" />
                            <p className="text-lg">Drag & Drop your <strong>.fit</strong> file here</p>
                            <p className="text-sm text-muted">or click to browse</p>
                        </label>
                        {isStravaConnected && (
                            <button onClick={handleStravaSync} className={styles.stravaSyncBtn}>
                                <RefreshCw size={14} /> Sync from Strava
                            </button>
                        )}
                        {status === 'error' && (
                            <div className={styles.error}>
                                <CircleAlert size={16} />
                                <span style={{ color: 'var(--accent-danger)' }}>{message}</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default FileDropzone;
