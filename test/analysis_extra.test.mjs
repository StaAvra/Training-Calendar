import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCriticalPower, calculateCriticalHeartRate, calculateNormalizedPower, calculateTrainingDNA } from '../src/utils/analysis.js';

test('calculateCriticalPower with known values', () => {
  const powerCurve = { duration_3m: 400, duration_20m: 300 };
  // Work1 = 400 * 180 = 72000
  // Work2 = 300 * 1200 = 360000
  // CP = (360000 - 72000) / (1200 - 180) = 288000 / 1020 = 282.3529 -> ~282
  const res = calculateCriticalPower(powerCurve);
  assert.ok(res && typeof res.cp === 'number');
  assert.strictEqual(res.cp, Math.round(( (300*1200) - (400*180) ) / (1200-180)));
});

test('calculateCriticalHeartRate with known values', () => {
  const hrCurve = { duration_3m: 160, duration_20m: 150 };
  const res = calculateCriticalHeartRate(hrCurve);
  // Beats1 = 160 * 3 = 480; Beats2 = 150 * 20 = 3000
  // CHR = (3000 - 480) / (20 - 3) = 2520 / 17 = 148.235 -> ~148
  assert.ok(res && typeof res.chr === 'number');
  assert.strictEqual(res.chr, Math.round((150*20 - 160*3) / (20 - 3)));
});

test('calculateNormalizedPower returns same value for constant stream', () => {
  const streams = [];
  // Create 60s stream of constant 200W values (>=30 required)
  for (let i=0;i<60;i++) streams.push({ power: 200 });
  const np = calculateNormalizedPower(streams);
  assert.strictEqual(np, 200);
});

test('calculateTrainingDNA ignores future planned rides for 12-week averages', () => {
  const now = Date.now();
  const completedPast = {
    date: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    completion_status: 'completed',
    completed: true,
    total_elapsed_time: 3600,
    training_stress_score: 80,
    avg_power: 180,
    normalized_power: 190,
  };

  const futurePlanned = {
    date: new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString(),
    completion_status: 'planned',
    planned: true,
    completed: false,
    total_elapsed_time: 4 * 3600,
    training_stress_score: 300,
    avg_power: 220,
    normalized_power: 230,
  };

  const dnaWithoutFuture = calculateTrainingDNA([completedPast], [], 250);
  const dnaWithFuture = calculateTrainingDNA([completedPast, futurePlanned], [], 250);

  assert.ok(dnaWithoutFuture?.longTermAverages, 'Expected long-term averages for baseline data');
  assert.ok(dnaWithFuture?.longTermAverages, 'Expected long-term averages with mixed data');
  assert.strictEqual(
    dnaWithFuture.longTermAverages.hrsPerWeek,
    dnaWithoutFuture.longTermAverages.hrsPerWeek,
    'Future planned rides should not affect 12-week average volume'
  );
  assert.strictEqual(
    dnaWithFuture.longTermAverages.tssPerWeek,
    dnaWithoutFuture.longTermAverages.tssPerWeek,
    'Future planned rides should not affect 12-week average TSS'
  );
});
