import assert from 'assert';
import { describe, it } from 'node:test';
import { estimateIfFromHr, estimateTssFromIf, calculateTSS, calculateTssWithMetadata, calculateHRZones, calculateTimeInHRZones, buildCurveFromStreams, getWorkoutPowerCurve, calculateCriticalPower } from '../src/utils/analysis.js';

describe('HR-based IF/TSS estimators', () => {
    it('estimateIfFromHr heuristic mapping returns plausible IF', () => {
        const res = estimateIfFromHr({ hrAvg: 150, restHr: 60, chr: 180, workoutHistory: [] });
        assert.ok(res && typeof res.ifEstimate === 'number');
        assert.ok(res.ifEstimate > 0.4 && res.ifEstimate < 1.2, `ifEstimate out of expected range: ${res.ifEstimate}`);
    });

    it('estimateTssFromIf computes expected TSS for 1h at IF 0.75', () => {
        const t = estimateTssFromIf(3600, 0.75);
        assert.strictEqual(t.tss, Math.round((3600 * Math.pow(0.75, 2)) / 36));
    });

    it('calculateTSS falls back to HR-based estimate when power missing', () => {
        const workout = {
            total_elapsed_time: 3600,
            avg_heart_rate: 150,
            resting_heart_rate: 60,
            critical_heart_rate: 180
        };

        const tss = calculateTSS(workout, null);
        // Compute expected via estimator chain
        const ifObj = estimateIfFromHr({ hrAvg: 150, restHr: 60, chr: 180, workoutHistory: [] });
        const expected = estimateTssFromIf(3600, ifObj.ifEstimate).tss;
        assert.strictEqual(tss, expected);
    });

    it('calculateTssWithMetadata returns power-based method when power available', () => {
        const workout = {
            total_elapsed_time: 3600,
            normalized_power: 200
        };
        const result = calculateTssWithMetadata(workout, 250);
        assert.strictEqual(result.method, 'power-based');
        assert.strictEqual(result.confidence, 1.0);
        assert.ok(result.tss > 0);
    });

    it('calculateTssWithMetadata returns hr-based method when power missing', () => {
        const workout = {
            total_elapsed_time: 3600,
            avg_heart_rate: 150,
            resting_heart_rate: 60,
            critical_heart_rate: 180,
            history: []
        };
        const result = calculateTssWithMetadata(workout, 250);
        assert.ok(result.method.includes('hr-based'));
        assert.ok(result.confidence > 0 && result.confidence < 1);
        assert.ok(result.tss > 0);
    });

    it('calculateTSS ignores elapsed time during power gaps from paused rides', () => {
        const rideWithPause = {
            total_elapsed_time: 7200,
            moving_time: 7200,
            normalized_power: 200,
            streams: [
                ...Array.from({ length: 3600 }, (_, i) => ({ time: i, power: 200 })),
                ...Array.from({ length: 1800 }, (_, i) => ({ time: 3600 + i, power: null })),
                ...Array.from({ length: 1800 }, (_, i) => ({ time: 5400 + i, power: 200 }))
            ]
        };

        const tss = calculateTSS(rideWithPause, 250);
        const expected = Math.round((5400 * 200 * (200 / 250)) / (250 * 36));
        assert.strictEqual(tss, expected);
        assert.ok(tss < Math.round((7200 * 200 * (200 / 250)) / (250 * 36)));
    });

    it('estimateIfFromHr improves with calibration data', () => {
        // Create synthetic calibration data (3+ rides with power and HR)
        const history = [
            { avg_heart_rate: 140, normalized_power: 200, ftp: 250, resting_heart_rate: 60, critical_heart_rate: 180 },
            { avg_heart_rate: 160, normalized_power: 280, ftp: 250, resting_heart_rate: 60, critical_heart_rate: 180 },
            { avg_heart_rate: 130, normalized_power: 150, ftp: 250, resting_heart_rate: 60, critical_heart_rate: 180 }
        ];

        const res = estimateIfFromHr({ hrAvg: 150, restHr: 60, chr: 180, workoutHistory: history });
        assert.strictEqual(res.method, 'calibrated');
        assert.ok(res.confidence > 0.5, `Expected calibrated confidence > 0.5, got ${res.confidence}`);
    });

    it('calculateHRZones creates 7 zones based on max HR', () => {
        const zones = calculateHRZones(190);
        assert.strictEqual(zones.length, 7);
        assert.strictEqual(zones[0].name, 'Active Recovery');
        assert.strictEqual(zones[6].name, 'Max Effort');
        // Check zone ranges are non-overlapping and sequential
        for (let i = 0; i < zones.length - 1; i++) {
            assert.ok(zones[i].max <= zones[i + 1].min, `Zone ${i} and ${i + 1} overlap`);
        }
    });

    it('calculateTimeInHRZones distributes HR stream into zones', () => {
        const streams = [
            { heart_rate: 100 },
            { heart_rate: 120 },
            { heart_rate: 140 },
            { heart_rate: 160 },
            { heart_rate: 180 }
        ];
        const distribution = calculateTimeInHRZones(streams, 190);
        assert.ok(distribution.length > 0);
        // Total time should match stream length
        const totalTime = distribution.reduce((sum, z) => sum + z.time, 0);
        assert.strictEqual(totalTime, streams.length);
    });

    it('calculateTimeInHRZones handles streams without HR data', () => {
        const streams = [
            { power: 200 },
            { power: 250 }
        ];
        const distribution = calculateTimeInHRZones(streams, 190);
        const totalTime = distribution.reduce((sum, z) => sum + z.time, 0);
        assert.strictEqual(totalTime, 0);
    });

    it('buildCurveFromStreams derives 3m and 20m values for CP estimation', () => {
        const streams = Array.from({ length: 1200 }, (_, index) => ({
            power: index < 180 ? 320 : 260,
            heart_rate: index < 180 ? 170 : 160,
        }));

        const curve = buildCurveFromStreams(streams, 'power');
        assert.strictEqual(curve.duration_3m, 320);
        assert.strictEqual(curve.duration_20m, 269);

        const cp = calculateCriticalPower(curve);
        assert.ok(cp);
        assert.strictEqual(cp.cp, 260);
    });

    it('getWorkoutPowerCurve falls back to stream-derived data when stored curve is missing', () => {
        const workout = {
            streams: Array.from({ length: 1200 }, () => ({ power: 280 }))
        };

        const curve = getWorkoutPowerCurve(workout);
        assert.ok(curve);
        assert.strictEqual(curve.duration_3m, 280);
        assert.strictEqual(curve.duration_20m, 280);
    });
});


