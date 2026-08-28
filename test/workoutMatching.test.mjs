import test from 'node:test';
import assert from 'node:assert/strict';
import { findPlannedWorkoutMatch } from '../src/utils/workoutMatching.js';

const plannedTemplate = {
  planned: true,
  completion_status: 'planned',
  plan_source: 'four_week'
};

test('matches planned workout on same local day', () => {
  const incomingStart = '2026-04-27T09:00:00.000Z';
  const workouts = [
    {
      id: 1,
      ...plannedTemplate,
      date: '2026-04-27T00:00:00.000Z',
      start_time: '2026-04-27T00:00:00.000Z'
    },
    {
      id: 2,
      completed: true,
      completion_status: 'completed',
      date: '2026-04-27T08:30:00.000Z'
    }
  ];

  const match = findPlannedWorkoutMatch(workouts, incomingStart);
  assert.ok(match, 'Expected planned workout to match');
  assert.strictEqual(match.id, 1);
});

test('does not match planned workout on different local day', () => {
  const incomingStart = '2026-04-27T09:00:00.000Z';
  const workouts = [
    {
      id: 3,
      ...plannedTemplate,
      date: '2026-04-26T00:00:00.000Z',
      start_time: '2026-04-26T00:00:00.000Z'
    }
  ];

  const match = findPlannedWorkoutMatch(workouts, incomingStart);
  assert.strictEqual(match, null);
});

test('returns closest planned workout when multiple on same day', () => {
  const incomingStart = '2026-04-27T10:05:00.000Z';
  const workouts = [
    {
      id: 4,
      ...plannedTemplate,
      date: '2026-04-27T00:00:00.000Z',
      start_time: '2026-04-27T06:00:00.000Z'
    },
    {
      id: 5,
      ...plannedTemplate,
      date: '2026-04-27T00:00:00.000Z',
      start_time: '2026-04-27T10:00:00.000Z'
    }
  ];

  const match = findPlannedWorkoutMatch(workouts, incomingStart);
  assert.ok(match, 'Expected planned workout to match');
  assert.strictEqual(match.id, 5);
});
