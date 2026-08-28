import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyWorkout } from '../src/utils/analysis.js';

const streamFromBlocks = (blocks) => blocks.flatMap(({ seconds, power }) => (
  Array.from({ length: seconds }, () => ({ power }))
));

test('classifyWorkout treats long easy-dominant rides as Endurance despite 30m+ Tempo', () => {
  const ftp = 250;

  // Long ride with mostly Recovery/Endurance, some Tempo, and modest high-intensity time.
  // This mirrors real rolling-route distributions where total Tempo can exceed 30m.
  const streams = streamFromBlocks([
    { seconds: 4800, power: 120 },
    { seconds: 3900, power: 165 },
    { seconds: 700, power: 200 },
    { seconds: 120, power: 120 },
    { seconds: 700, power: 200 },
    { seconds: 120, power: 120 },
    { seconds: 700, power: 200 },
    { seconds: 120, power: 120 },
    { seconds: 700, power: 200 },
    { seconds: 300, power: 235 },
    { seconds: 120, power: 120 },
    { seconds: 300, power: 235 },
    { seconds: 120, power: 120 },
    { seconds: 300, power: 235 },
    { seconds: 120, power: 120 },
    { seconds: 600, power: 270 },
    { seconds: 120, power: 120 },
    { seconds: 420, power: 310 },
  ]);

  const type = classifyWorkout({ streams }, ftp);
  assert.equal(type, 'Endurance');
});

test('classifyWorkout keeps Tempo label for non-easy-dominant rides', () => {
  const ftp = 250;

  const streams = streamFromBlocks([
    { seconds: 900, power: 120 },
    { seconds: 2700, power: 200 },
    { seconds: 600, power: 120 },
    { seconds: 600, power: 235 },
  ]);

  const type = classifyWorkout({ streams }, ftp);
  assert.equal(type, 'Tempo');
});
