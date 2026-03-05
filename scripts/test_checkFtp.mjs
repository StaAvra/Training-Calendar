import { checkFtpImprovement } from '../src/utils/analysis.js';

const workouts = [
  // Best long ride (30min NP)
  {
    id: 'w1',
    date: new Date().toISOString(),
    total_elapsed_time: 1800,
    normalized_power: 280,
    avg_power: 270,
    avg_heart_rate: 160,
    // hr_curve to allow CHR calculation
    hr_curve: {
      duration_3m: 160,
      duration_20m: 155
    }
  },
  // Threshold-like ride (15min)
  {
    id: 'w2',
    date: new Date(Date.now() - 86400000).toISOString(),
    total_elapsed_time: 900,
    normalized_power: 0,
    avg_power: 275,
    avg_heart_rate: 150
  }
];

(async () => {
  console.log('Test 1: currentFtp = 250 (expect bestRide suggestion)');
  const res1 = checkFtpImprovement(workouts, 250);
  console.log(JSON.stringify(res1, null, 2));

  console.log('\nTest 2: currentFtp = 270 (expect thresholdRide suggestion)');
  const res2 = checkFtpImprovement(workouts, 270);
  console.log(JSON.stringify(res2, null, 2));

  console.log('\nTest 3: pass profile.maxHr = 200 and currentFtp = 270 (CHR fallback uses 90% of maxHr)');
  const res3 = checkFtpImprovement(workouts, 270, { maxHr: 200 });
  console.log(JSON.stringify(res3, null, 2));
})();
