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
