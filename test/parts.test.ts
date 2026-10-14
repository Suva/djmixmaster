import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameForParts, orderParts } from '../src/app/parts.ts';

test('parts a recorder numbered are named by what they share', () => {
  assert.equal(nameForParts(['REC001.WAV', 'REC002.WAV', 'REC003.WAV']), 'REC00*.WAV (3 files)');
  assert.equal(nameForParts(['Night part 1.wav', 'Night part 2.wav']), 'Night part *.wav (2 files)');
});

test('parts named by hand are named after the first, with a count', () => {
  assert.equal(nameForParts(['Opening.wav', 'Peak time.wav']), 'Opening.wav + 1 more');
  // "day.wav" in common is chance, not a name.
  assert.equal(nameForParts(['Friday.wav', 'Saturday.wav', 'Sunday.wav']), 'Friday.wav + 2 more');
});

test('numbered parts go in the order of their numbers, others in the order they were written', () => {
  const at = (path: string, modified: number) => ({ path: `/rec/${path}`, modified });
  assert.deepEqual(
    orderParts([at('part 10.wav', 1), at('part 2.wav', 3), at('part 1.wav', 2)]),
    ['/rec/part 1.wav', '/rec/part 2.wav', '/rec/part 10.wav'],
  );
  assert.deepEqual(
    orderParts([at('Peak time.wav', 20), at('Opening.wav', 30), at('Closing.wav', 10)]),
    ['/rec/Closing.wav', '/rec/Peak time.wav', '/rec/Opening.wav'],
  );
});
