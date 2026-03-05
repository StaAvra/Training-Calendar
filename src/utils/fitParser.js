import FitParser from 'fit-file-parser';

export const parseFitFile = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (event) => {
            const content = event.target.result;
            const fitParser = new FitParser({
                force: true,
                speedUnit: 'km/h',
                lengthUnit: 'm',
                temperatureUnit: 'celsius',
                elapsedRecordField: true,
                mode: 'both',
            });

            fitParser.parse(content, (error, data) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(processFitData(data));
                }
            });
        };

        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
};

const calculateNormalizedPower = (streams) => {
    if (!streams || streams.length < 30) return 0;

    const rollingAvgs = [];

    for (let i = 0; i < streams.length; i++) {
        if (i < 29) continue;

        let sum = 0;
        let count = 0;
        for (let j = 0; j < 30; j++) {
            const p = streams[i - j].power || 0;
            sum += p;
            count++;
        }
        rollingAvgs.push(sum / count);
    }

    if (rollingAvgs.length === 0) return 0;

    const sumPow4 = rollingAvgs.reduce((acc, val) => acc + Math.pow(val, 4), 0);
    const avgPow4 = sumPow4 / rollingAvgs.length;
    return Math.round(Math.pow(avgPow4, 0.25));
};

const calculateRollingAverageMax = (streams, durationSeconds, field = 'power') => {
    if (!streams || streams.length < durationSeconds) return null;

    let maxVal = 0;
    let currentSum = 0;

    // Initial window
    for (let i = 0; i < durationSeconds; i++) {
        currentSum += (streams[i][field] || 0);
    }
    maxVal = currentSum / durationSeconds;

    // Slide window
    for (let i = durationSeconds; i < streams.length; i++) {
        currentSum += (streams[i][field] || 0);
        currentSum -= (streams[i - durationSeconds][field] || 0);
        const avg = currentSum / durationSeconds;
        if (avg > maxVal) maxVal = avg;
    }

    return Math.round(maxVal);
};

const processFitData = (data) => {
    // Extract summary
    const session = data.sessions?.[0] || {};

    // Extract records (time series)
    const records = data.records || [];

    // Simplify records for storage/analysis
    const streams = records.map(record => ({
        time: record.elapsed_time, // seconds
        power: record.power,
        heart_rate: record.heart_rate,
        cadence: record.cadence,
        speed: record.speed,
        distance: record.distance
    }));

    // Manual NP Calc if needed (or always to override bad file data as requested)
    const calculatedNP = calculateNormalizedPower(streams);

    // Calculate Power Curve (MMP)
    const power_curve = {
        duration_5s: calculateRollingAverageMax(streams, 5, 'power'),
        duration_10s: calculateRollingAverageMax(streams, 10, 'power'),
        duration_1m: calculateRollingAverageMax(streams, 60, 'power'),
        duration_2m: calculateRollingAverageMax(streams, 120, 'power'),
        duration_3m: calculateRollingAverageMax(streams, 180, 'power'),
        duration_5m: calculateRollingAverageMax(streams, 300, 'power'),
        duration_8m: calculateRollingAverageMax(streams, 480, 'power'),
        duration_10m: calculateRollingAverageMax(streams, 600, 'power'),
        duration_12m: calculateRollingAverageMax(streams, 720, 'power'),
        duration_15m: calculateRollingAverageMax(streams, 900, 'power'),
        duration_20m: calculateRollingAverageMax(streams, 1200, 'power'),
        duration_60m: calculateRollingAverageMax(streams, 3600, 'power'),
    };

    // Calculate Heart Rate Curve (Peak sustained HR)
    const hr_curve = {
        duration_5s: calculateRollingAverageMax(streams, 5, 'heart_rate'),
        duration_10s: calculateRollingAverageMax(streams, 10, 'heart_rate'),
        duration_1m: calculateRollingAverageMax(streams, 60, 'heart_rate'),
        duration_2m: calculateRollingAverageMax(streams, 120, 'heart_rate'),
        duration_3m: calculateRollingAverageMax(streams, 180, 'heart_rate'),
        duration_5m: calculateRollingAverageMax(streams, 300, 'heart_rate'),
        duration_8m: calculateRollingAverageMax(streams, 480, 'heart_rate'),
        duration_10m: calculateRollingAverageMax(streams, 600, 'heart_rate'),
        duration_12m: calculateRollingAverageMax(streams, 720, 'heart_rate'),
        duration_15m: calculateRollingAverageMax(streams, 900, 'heart_rate'),
        duration_20m: calculateRollingAverageMax(streams, 1200, 'heart_rate'),
        duration_60m: calculateRollingAverageMax(streams, 3600, 'heart_rate'),
    };

    return {
        source: 'fit_file',
        imported_at: new Date().toISOString(),
        start_time: session.start_time,
        total_elapsed_time: session.total_elapsed_time,
        total_distance: session.total_distance,
        avg_speed: session.avg_speed,
        avg_power: session.avg_power,
        max_power: session.max_power,
        avg_heart_rate: session.avg_heart_rate || (streams.filter(s => s.heart_rate).length > 0 ? (streams.filter(s => s.heart_rate).reduce((acc, s) => acc + s.heart_rate, 0) / streams.filter(s => s.heart_rate).length) : 0),
        max_heart_rate: session.max_heart_rate || (streams.filter(s => s.heart_rate).length > 0 ? Math.max(...streams.filter(s => s.heart_rate).map(s => s.heart_rate)) : 0),
        normalized_power: calculatedNP || session.normalized_power || session.avg_power,
        intensity_factor: session.intensity_factor,
        training_stress_score: session.training_stress_score,
        total_work: session.total_work, // Joule
        functional_threshold_power: session.functional_threshold_power || session.threshold_power, // Historical FTP "Stamp"
        streams: streams,
        power_curve: power_curve,
        heart_rate_curve: hr_curve
    };
};
