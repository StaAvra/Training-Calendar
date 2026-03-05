import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCriticalPower, calculateCriticalHeartRate, calculateNormalizedPower } from '../src/utils/analysis.js';

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
