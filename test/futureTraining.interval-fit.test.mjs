import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecommendation } from '../src/utils/intelligence.js';

const profile = {
  ftp: 309,
  weight: 70,
  maxHr: 190
};

const analysis = {
  insufficientData: false,
  adaptations: [],
  workouts: [],
  stagnationZones: []
};

const getBlockMins = (details) => {
  if (!details) return 0;
  const reps = Number(details.reps || 0);
  const interval = Number(details.intervalMins || 0);
  const rest = Number(details.restMins || 0);
  return (reps * interval) + (Math.max(0, reps - 1) * rest);
};

const getReservedWarmupCooldownMins = (sessionMins) => {
  if (sessionMins <= 45) return 10;
  if (sessionMins <= 75) return 12;
  if (sessionMins <= 105) return 15;
  return 20;
};

test('structured intervals fit session duration with warmup/cooldown reserve', () => {
  const rec = generateRecommendation(analysis, profile, 'Increase FTP', 4, 5, []);
  assert.ok(rec?.fourWeekPlan?.weeks?.length, 'Expected generated 4-week plan');

  for (const week of rec.fourWeekPlan.weeks) {
    for (const session of (week.sessions || [])) {
      if (!session.intervalDetails) continue;

      const sessionMins = Math.round((session.hoursPerSession || 0) * 60);
      const blockMins = getBlockMins(session.intervalDetails);
      const reservedMins = getReservedWarmupCooldownMins(sessionMins);

      assert.ok(
        blockMins <= Math.max(0, sessionMins - reservedMins),
        `Interval block ${blockMins}min exceeds allowed work block for ${sessionMins}min session: ${session.intervalDetails.label}`
      );

      if (sessionMins <= 45) {
        assert.equal(reservedMins, 10);
      }
    }
  }
});

test('all generated structured interval targets use an exact 10W power band', () => {
  const workouts = [
    {
      date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 285,
      structured_power_high: 295,
      execution_success: true,
      success_score: 94,
      total_elapsed_time: 3600
    }
  ];

  const rec = generateRecommendation(analysis, profile, 'Climbing', 7, 5, workouts);
  assert.ok(rec?.fourWeekPlan?.weeks?.length, 'Expected generated multi-week plan');

  let structuredCount = 0;
  for (const week of rec.fourWeekPlan.weeks) {
    for (const session of (week.sessions || [])) {
      const details = session.intervalDetails;
      if (!details) continue;
      structuredCount += 1;
      assert.equal(
        Number(details.powerHigh) - Number(details.powerLow),
        10,
        `Expected 10W band but got ${details.powerLow}-${details.powerHigh}W`
      );
    }
  }

  assert.ok(structuredCount > 0, 'Expected at least one structured session in generated plan');
});

test('power progression only increases when recent same-zone completion is successful', () => {
  const now = Date.now();
  const successfulThresholdHistory = [
    {
      date: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 290,
      structured_power_high: 300,
      execution_success: true,
      success_score: 95,
      total_elapsed_time: 3600
    },
    {
      date: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 290,
      structured_power_high: 300,
      execution_success: true,
      success_score: 96,
      total_elapsed_time: 3600
    }
  ];

  const failedThresholdHistory = [
    {
      date: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 290,
      structured_power_high: 300,
      execution_success: false,
      success_score: 70,
      rpe: 9,
      feeling_strength: 4,
      total_elapsed_time: 3600
    },
    {
      date: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 290,
      structured_power_high: 300,
      execution_success: false,
      success_score: 72,
      rpe: 9,
      feeling_strength: 4,
      total_elapsed_time: 3600
    }
  ];

  const recSuccess = generateRecommendation(analysis, profile, 'Climbing', 8, 5, successfulThresholdHistory);
  const recFailure = generateRecommendation(analysis, profile, 'Climbing', 8, 5, failedThresholdHistory);

  const getThresholdLows = (rec) => rec.fourWeekPlan.weeks
    .flatMap(week => week.sessions || [])
    .filter(s => s.intervalZone === 'threshold' && s.intervalDetails)
    .map(s => Number(s.intervalDetails.powerLow));

  const successLows = getThresholdLows(recSuccess);
  const failureLows = getThresholdLows(recFailure);

  assert.ok(successLows.length > 0, 'Expected threshold sessions with successful history');
  assert.ok(failureLows.length > 0, 'Expected threshold sessions with failed history');

  const successMax = Math.max(...successLows);
  const failureMax = Math.max(...failureLows);

  assert.ok(successMax > 290, `Expected a power increase above anchor with successful history, got max ${successMax}W`);
  assert.ok(failureMax <= 290, `Expected no power increase with failed history, got max ${failureMax}W`);
});

test('suggested training approach is returned with confidence metadata', () => {
  const rec = generateRecommendation(analysis, profile, 'Climbing', 8, 5, [], 'suggested');
  assert.ok(rec?.suggestedApproach, 'Expected suggested approach metadata');
  assert.ok(rec?.trainingApproach?.key, 'Expected resolved training approach config');
  assert.ok(typeof rec.suggestedApproach.confidence === 'number', 'Expected numeric confidence');
});

test('hard recent untagged structured intervals anchor power recommendations', () => {
  const now = Date.now();
  const hardHistory = [
    {
      date: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      title: 'VO2 session',
      structured_reps: 4,
      structured_interval_mins: 4,
      structured_rest_mins: 4,
      structured_power_low: 340,
      structured_power_high: 350,
      success_score: 91,
      avg_power: 338,
      normalized_power: 346,
      total_elapsed_time: 4200
    }
  ];

  const rec = generateRecommendation(analysis, profile, 'Speed', 8, 5, hardHistory, 'aggressive');
  const lows = rec.fourWeekPlan.weeks
    .flatMap(week => week.sessions || [])
    .map(session => Number(session.intervalDetails?.powerLow || 0))
    .filter(low => Number.isFinite(low) && low > 0);

  assert.ok(lows.length > 0, 'Expected structured intervals in generated plan');
  assert.ok(Math.max(...lows) >= 340, `Expected anchored power to preserve hard recent capability, got max ${Math.max(...lows)}W`);
});

test('training approach selection changes interval prescription difficulty', () => {
  const now = Date.now();
  const history = [
    {
      date: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 300,
      structured_power_high: 310,
      success_score: 93,
      execution_success: true,
      avg_power: 304,
      normalized_power: 309,
      total_elapsed_time: 4200
    }
  ];

  const conservative = generateRecommendation(analysis, profile, 'Climbing', 8, 5, history, 'conservative');
  const veryAggressive = generateRecommendation(analysis, profile, 'Climbing', 8, 5, history, 'very_aggressive');

  const extractThresholdHigh = (rec) => rec.fourWeekPlan.weeks
    .flatMap(week => week.sessions || [])
    .filter(session => session.intervalZone === 'threshold' && session.intervalDetails)
    .map(session => Number(session.intervalDetails.powerLow));

  const conservativeHigh = Math.max(...extractThresholdHigh(conservative));
  const veryAggressiveHigh = Math.max(...extractThresholdHigh(veryAggressive));

  assert.ok(veryAggressiveHigh > conservativeHigh, `Expected very aggressive (${veryAggressiveHigh}W) to exceed conservative (${conservativeHigh}W)`);
  assert.ok(
    (veryAggressiveHigh - conservativeHigh) >= 10,
    `Expected meaningful separation (>=10W), got ${veryAggressiveHigh - conservativeHigh}W`
  );
});

test('8-week plan includes interval progression over time', () => {
  const now = Date.now();
  const history = [
    {
      date: new Date(now - 12 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 300,
      structured_power_high: 310,
      success_score: 92,
      execution_success: true,
      total_elapsed_time: 4100
    },
    {
      date: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 304,
      structured_power_high: 314,
      success_score: 95,
      execution_success: true,
      total_elapsed_time: 4300
    }
  ];

  const rec = generateRecommendation(analysis, profile, 'Climbing', 8, 5, history, 'aggressive');
  const thresholdDetails = rec.fourWeekPlan.weeks
    .flatMap(week => (week.sessions || []).map(session => ({ week: week.weekNumber, session })))
    .filter(({ session }) => session.intervalZone === 'threshold' && session.intervalDetails)
    .map(({ week, session }) => `${week}:${session.intervalDetails.reps}x${session.intervalDetails.intervalMins}@${session.intervalDetails.powerLow}`);

  assert.ok(thresholdDetails.length >= 3, `Expected repeated threshold exposures across block, got ${thresholdDetails.length}`);
  const unique = new Set(thresholdDetails);
  assert.ok(unique.size > 1, 'Expected interval details to progress across the 8-week block, but values remained static');
});

test('manual approach selection changes displayed approach confidence', () => {
  const now = Date.now();
  const history = [
    {
      date: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 4,
      structured_interval_mins: 6,
      structured_rest_mins: 4,
      structured_power_low: 300,
      structured_power_high: 310,
      success_score: 92,
      execution_success: true,
      total_elapsed_time: 4200
    }
  ];

  const suggested = generateRecommendation(analysis, profile, 'Climbing', 8, 5, history, 'suggested');
  const conservative = generateRecommendation(analysis, profile, 'Climbing', 8, 5, history, 'conservative');
  const veryAggressive = generateRecommendation(analysis, profile, 'Climbing', 8, 5, history, 'very_aggressive');

  assert.ok(typeof suggested.selectedApproachConfidence === 'number', 'Expected selected approach confidence in recommendation');
  assert.ok(typeof conservative.selectedApproachConfidence === 'number', 'Expected selected approach confidence for manual conservative');
  assert.ok(typeof veryAggressive.selectedApproachConfidence === 'number', 'Expected selected approach confidence for manual very aggressive');

  const distinct = new Set([
    Math.round(suggested.selectedApproachConfidence),
    Math.round(conservative.selectedApproachConfidence),
    Math.round(veryAggressive.selectedApproachConfidence)
  ]);
  assert.ok(distinct.size >= 2, 'Expected approach confidence to vary when selecting different training approaches');
});

test('race constraints trigger taper focus when race week enters planning horizon', () => {
  const now = new Date();
  const nextMonday = new Date(now);
  const day = nextMonday.getDay();
  const daysUntilMonday = day === 0 ? 1 : (8 - day);
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);

  const raceDate = new Date(nextMonday);
  raceDate.setDate(raceDate.getDate() + (7 * 7) + 2); // week 8, mid-week

  const rec = generateRecommendation(
    analysis,
    profile,
    'Climbing',
    8,
    5,
    [],
    'balanced',
    {
      restWeekCadence: 4,
      planStartDate: nextMonday.toISOString(),
      constraints: [
        {
          type: 'race',
          precedence: 'soft',
          startDate: raceDate.toISOString(),
          endDate: raceDate.toISOString(),
          blockTraining: false,
        }
      ]
    }
  );

  const week7 = rec?.fourWeekPlan?.weeks?.find(w => w.weekNumber === 7);
  const week8 = rec?.fourWeekPlan?.weeks?.find(w => w.weekNumber === 8);

  assert.ok(week8, 'Expected week 8 in generated plan');
  assert.ok(String(week8.focus || '').toLowerCase().includes('race'), `Expected race/taper focus for week 8, got: ${week8.focus}`);
  assert.ok(week7, 'Expected week 7 in generated plan');
  assert.ok(week8.totalWeeklyHours <= week7.totalWeeklyHours, 'Expected taper effect to reduce race-week volume');
});

test('hard block overrides race/taper when constraints overlap same day', () => {
  const now = new Date();
  const nextMonday = new Date(now);
  const day = nextMonday.getDay();
  const daysUntilMonday = day === 0 ? 1 : (8 - day);
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);

  const overlapDate = new Date(nextMonday);
  overlapDate.setDate(overlapDate.getDate() + (6 * 7) + 3); // week 7, mid-week

  const rec = generateRecommendation(
    analysis,
    profile,
    'Climbing',
    8,
    5,
    [],
    'balanced',
    {
      restWeekCadence: 4,
      planStartDate: nextMonday.toISOString(),
      constraints: [
        {
          type: 'race',
          precedence: 'hard',
          startDate: overlapDate.toISOString(),
          endDate: overlapDate.toISOString(),
          blockTraining: true,
        },
        {
          type: 'unavailable',
          precedence: 'hard',
          startDate: overlapDate.toISOString(),
          endDate: overlapDate.toISOString(),
          blockTraining: true,
        },
        {
          type: 'taper',
          precedence: 'soft',
          startDate: overlapDate.toISOString(),
          endDate: overlapDate.toISOString(),
          reduceAvailability: 0.5,
        }
      ]
    }
  );

  const week7 = rec?.fourWeekPlan?.weeks?.find(w => w.weekNumber === 7);
  assert.ok(week7, 'Expected week 7 in generated plan');
  assert.ok(
    !String(week7.focus || '').toLowerCase().includes('race'),
    `Expected hard overlap to suppress race/taper focus, got ${week7.focus}`
  );
});
