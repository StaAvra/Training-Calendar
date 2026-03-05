import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFtpImprovement } from '../src/utils/analysis.js';

const workouts = [
  {
    id: 'w1',
    date: new Date().toISOString(),
    total_elapsed_time: 1800,
    normalized_power: 280,
    avg_power: 270,
    avg_heart_rate: 160,
    hr_curve: { duration_3m: 160, duration_20m: 155 }
  },
  {
    id: 'w2',
    date: new Date(Date.now() - 86400000).toISOString(),
    total_elapsed_time: 900,
    normalized_power: 0,
    avg_power: 275,
    avg_heart_rate: 150
  }
];

test('best ride suggests FTP increase when NP > currentFtp * 1.05', () => {
  const res = checkFtpImprovement(workouts, 250);
  assert.ok(res && res.suggestedUpdate, 'Expected a suggestion');
  assert.strictEqual(res.suggestedUpdate, Math.round(280 * 0.95));
});

test('threshold ride suggests when avg_power > currentFtp and HR < CHR', () => {
  const res = checkFtpImprovement(workouts, 270);
  assert.ok(res && res.suggestedUpdate, 'Expected a suggestion');
  assert.strictEqual(res.suggestedUpdate, 275);
});

test('profile maxHr fallback does not crash and still suggests', () => {
  const res = checkFtpImprovement(workouts, 270, { maxHr: 200 });
  assert.ok(res && res.suggestedUpdate, 'Expected a suggestion');
});
