import React, { useCallback, useState } from 'react';
import { useUser } from '../context/UserContext';
import { Upload, FileCheck, CircleAlert } from 'lucide-react';
import { parseFitFile } from '../utils/fitParser';
import { db } from '../utils/db';
import styles from './FileDropzone.module.css';

const FileDropzone = ({ onUploadComplete }) => {
    const { currentUser } = useUser();
    const [isDragOver, setIsDragOver] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [status, setStatus] = useState(null); // 'success', 'error'
    const [message, setMessage] = useState('');

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
