import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeResponderProfile, generateRecommendation } from '../src/utils/intelligence.js';

const isoDay = (value) => new Date(value).toISOString();

const buildWorkout = ({ date, power, durationSeconds, tss, feeling, cp20m }) => ({
  date: isoDay(date),
  total_elapsed_time: durationSeconds,
  training_stress_score: tss,
  feeling_strength: feeling,
  streams: Array.from({ length: durationSeconds }, () => ({ power })),
  power_curve: {
    duration_1m: Math.round(cp20m * 1.45),
    duration_5m: Math.round(cp20m * 1.18),
    duration_20m: cp20m
  }
});

const buildIntensityAnalysis = () => {
  const workouts = [];
  const adaptations = [];
  const adaptationDates = [
    '2025-01-31T00:00:00.000Z',
    '2025-03-07T00:00:00.000Z',
    '2025-04-11T00:00:00.000Z',
    '2025-05-16T00:00:00.000Z'
  ];

  adaptationDates.forEach((date, index) => {
    const endDate = new Date(date);
    for (let workoutIndex = 0; workoutIndex < 4; workoutIndex += 1) {
      const workoutDate = new Date(endDate);
      workoutDate.setDate(endDate.getDate() - (workoutIndex * 5));
      workouts.push(buildWorkout({
        date: workoutDate,
        power: 300,
        durationSeconds: 75 * 60,
        tss: 95,
        feeling: 8,
        cp20m: 265 + (index * 6)
      }));
    }

    adaptations.push({
      date,
      type: 'Stress Adaptation',
      improvements: ['Threshold (20m)', 'VO2 Max (5m)'],
      avgTss: 380,
      avgVol: 5.1,
      avgFeeling: 8.2
    });
  });

  return {
    workouts,
    weeklyStats: [
      { volume: 4.8 },
      { volume: 5.0 },
      { volume: 5.1 },
      { volume: 5.2 }
    ],
    adaptations,
    stagnationZones: []
  };
};

const buildVolumeAnalysis = () => {
  const workouts = [];
  const adaptations = [];
  const adaptationDates = [
    '2025-01-31T00:00:00.000Z',
    '2025-03-07T00:00:00.000Z',
    '2025-04-11T00:00:00.000Z',
    '2025-05-16T00:00:00.000Z'
  ];

  adaptationDates.forEach((date, index) => {
    const endDate = new Date(date);
    for (let workoutIndex = 0; workoutIndex < 5; workoutIndex += 1) {
      const workoutDate = new Date(endDate);
      workoutDate.setDate(endDate.getDate() - (workoutIndex * 4));
      workouts.push(buildWorkout({
        date: workoutDate,
        power: 165,
        durationSeconds: 2 * 60 * 60,
        tss: 62,
        feeling: 7,
        cp20m: 250 + (index * 4)
      }));
    }

    adaptations.push({
      date,
      type: 'Stress Adaptation',
      improvements: ['Consistent Volume Growth'],
      avgTss: 310,
      avgVol: 9.4,
      avgFeeling: 7.6
    });
  });

  return {
    workouts,
    weeklyStats: [
      { volume: 8.8 },
      { volume: 9.0 },
      { volume: 9.1 },
      { volume: 9.3 }
    ],
    adaptations,
    stagnationZones: []
  };
};

test('analyzeResponderProfile identifies intensity responders from trained local blocks', () => {
  const profile = analyzeResponderProfile(buildIntensityAnalysis(), { ftp: 250, phenotype: 'All Rounder' });

  assert.equal(profile.responderType, 'Intensity');
  assert.ok(profile.intensityResponderScore > profile.volumeResponderScore);
  assert.ok(profile.trainedBlockCount >= 4);
  assert.ok(profile.confidence >= 35);
  assert.equal(profile.modelType, 'prototype-knn-v1');
});

test('analyzeResponderProfile identifies volume responders from aerobic blocks', () => {
  const profile = analyzeResponderProfile(buildVolumeAnalysis(), { ftp: 250, phenotype: 'Time Trialist' });

  assert.equal(profile.responderType, 'Volume');
  assert.ok(profile.volumeResponderScore > profile.intensityResponderScore);
  assert.ok(profile.bestHistoricalMix.endurance > profile.bestHistoricalMix.threshold);
});

test('generateRecommendation includes ML-backed responder profile and description', () => {
  const recommendation = generateRecommendation(
    buildIntensityAnalysis(),
    { ftp: 250, phenotype: 'Sprinter' },
    'Climbing',
    6,
    4
  );

  assert.ok(recommendation.responderProfile);
  assert.equal(recommendation.responderProfile.responderType, 'Intensity');
  assert.match(recommendation.description, /local model/i);
  assert.ok(Array.isArray(recommendation.focusZones));
  assert.ok(recommendation.weeklyPlan);
});

test('safety recent average uses completed past workouts, not stale weeklyStats', () => {
  const now = Date.now();
  const h = 60 * 60;

  const recentCompletedWorkouts = [
    { date: new Date(now - 3 * 24 * h * 1000).toISOString(), total_elapsed_time: 4 * h, planned: false },
    { date: new Date(now - 10 * 24 * h * 1000).toISOString(), total_elapsed_time: 4 * h, planned: false },
    { date: new Date(now - 17 * 24 * h * 1000).toISOString(), total_elapsed_time: 4 * h, planned: false },
    { date: new Date(now - 24 * 24 * h * 1000).toISOString(), total_elapsed_time: 4 * h, planned: false }
  ];

  const futurePlanned = {
    date: new Date(now + 7 * 24 * h * 1000).toISOString(),
    total_elapsed_time: 5 * h,
    planned: true,
    completion_status: 'planned',
    plan_source: 'four_week'
  };

  const analysis = {
    insufficientData: false,
    workouts: [...recentCompletedWorkouts, futurePlanned],
    // Intentionally low/stale weeklyStats to ensure workouts are used for recent average.
    weeklyStats: [{ volume: 2.3 }, { volume: 2.3 }, { volume: 2.3 }, { volume: 2.3 }],
    adaptations: [],
    stagnationZones: []
  };

  const recommendation = generateRecommendation(
    analysis,
    { ftp: 250, phenotype: 'All Rounder' },
    'Increase FTP',
    5,
    5,
    analysis.workouts
  );

  assert.match(recommendation.description, /recent average is \*\*4\.0h\/week\*\*/i);
  assert.ok(recommendation.description.includes('requested **5h/week**'));
});

test('generateRecommendation builds from recent structured interval anchors', () => {
  const now = Date.now();
  const workouts = [
    {
      id: 1,
      date: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      total_elapsed_time: 90 * 60,
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'tempo',
      structured_reps: 3,
      structured_interval_mins: 20,
      structured_rest_mins: 5,
      structured_power_low: 247,
      structured_power_high: 267,
      execution_success: true,
      success_score: 96,
    },
    {
      id: 2,
      date: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      total_elapsed_time: 70 * 60,
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'threshold',
      structured_reps: 3,
      structured_interval_mins: 10,
      structured_rest_mins: 5,
      structured_power_low: 294,
      structured_power_high: 314,
      execution_success: true,
      success_score: 94,
    },
    {
      id: 3,
      date: new Date(now - 11 * 24 * 60 * 60 * 1000).toISOString(),
      total_elapsed_time: 60 * 60,
      completion_status: 'completed',
      completed: true,
      planned_interval_zone: 'vo2max',
      structured_reps: 4,
      structured_interval_mins: 5,
      structured_rest_mins: 4,
      structured_power_low: 334,
      structured_power_high: 354,
      execution_success: true,
      success_score: 95,
    },
    {
      id: 4,
      date: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
      total_elapsed_time: 6 * 60 * 60,
      completion_status: 'completed',
      completed: true,
    },
    {
      id: 5,
      date: new Date(now - 21 * 24 * 60 * 60 * 1000).toISOString(),
      total_elapsed_time: 6 * 60 * 60,
      completion_status: 'completed',
      completed: true,
    },
    {
      id: 6,
      date: new Date(now - 26 * 24 * 60 * 60 * 1000).toISOString(),
      total_elapsed_time: 6 * 60 * 60,
      completion_status: 'completed',
      completed: true,
    }
  ];

  const analysis = {
    insufficientData: false,
    workouts,
    weeklyStats: [{ volume: 5 }, { volume: 5 }, { volume: 5 }, { volume: 5 }],
    adaptations: [],
    stagnationZones: []
  };

  const recommendation = generateRecommendation(analysis, { ftp: 309, phenotype: 'All Rounder' }, 'climbing', 6, 5, workouts);
  const labels = recommendation.fourWeekPlan.weeks
    .flatMap(week => week.sessions || [])
    .filter(session => session.intervalDetails)
    .map(session => session.intervalDetails.label)
    .join(' | ');

  const vo2Sessions = recommendation.fourWeekPlan.weeks
    .flatMap(week => week.sessions || [])
    .filter(session => session.intervalZone === 'vo2max' && session.intervalDetails)
    .map(session => session.intervalDetails);

  assert.match(labels, /3×20min @ 247-257W/i);
  assert.match(labels, /3×10min @ 294-304W/i);
  assert.ok(vo2Sessions.length > 0, 'Expected VO2 sessions from structured history anchor');
  assert.ok(
    vo2Sessions.some(session => Number(session.powerLow) >= 334),
    `Expected at least one VO2 target to preserve hard anchor >=334W, got: ${vo2Sessions.map(s => s.powerLow).join(', ')}`
  );
  assert.ok(
    vo2Sessions.some(session => Number(session.intervalMins) >= 5),
    `Expected VO2 duration progression to include >=5min intervals, got: ${vo2Sessions.map(s => s.intervalMins).join(', ')}`
  );
});

test('generateRecommendation returns an 8-week adaptive block with rotated intensity types', () => {
  const recommendation = generateRecommendation(
    buildIntensityAnalysis(),
    { ftp: 250, phenotype: 'All Rounder' },
    'climbing',
    6,
    5
  );

  assert.equal(recommendation.fourWeekPlan.weeks.length, 8);

  const weekOneTypes = recommendation.fourWeekPlan.weeks[0].sessions.map(s => s.type).sort().join(',');
  const weekTwoTypes = recommendation.fourWeekPlan.weeks[1].sessions.map(s => s.type).sort().join(',');
  const weekThreeTypes = recommendation.fourWeekPlan.weeks[2].sessions.map(s => s.type).sort().join(',');

  assert.notEqual(weekOneTypes, weekTwoTypes);
  assert.notEqual(weekTwoTypes, weekThreeTypes);
});

test('generateRecommendation applies rest week cadence preference (every 3 weeks)', () => {
  const recommendation = generateRecommendation(
    buildIntensityAnalysis(),
    { ftp: 250, phenotype: 'All Rounder' },
    'climbing',
    6,
    5,
    [],
    'balanced',
    { restWeekCadence: 3 }
  );

  const recoveryWeeks = recommendation.fourWeekPlan.weeks
    .filter(week => week.focus === 'Recovery & Adaptation')
    .map(week => week.weekNumber);

  assert.deepEqual(recoveryWeeks, [3, 6]);
  assert.equal(recommendation.plannerSettings?.restWeekCadence, 3);
});

test('generateRecommendation applies rest week cadence preference (every 2 weeks)', () => {
  const recommendation = generateRecommendation(
    buildIntensityAnalysis(),
    { ftp: 250, phenotype: 'All Rounder' },
    'climbing',
    6,
    5,
    [],
    'balanced',
    { restWeekCadence: 2 }
  );

  const recoveryWeeks = recommendation.fourWeekPlan.weeks
    .filter(week => week.focus === 'Recovery & Adaptation')
    .map(week => week.weekNumber);

  assert.deepEqual(recoveryWeeks, [2, 4, 6, 8]);
  assert.equal(recommendation.plannerSettings?.restWeekCadence, 2);
});
