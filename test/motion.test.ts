import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../src/visuals/expression.ts';
import { MUSIC_NAMES } from '../src/visuals/music.ts';
import { motionExpression, parseMotion, type Motion } from '../src/visuals/motion.ts';

const motion = (changes: Partial<Motion>): Motion => ({ base: 100, amount: 8, source: 'bass', speed: 'smooth', period: 8, ...changes });

test('a motion is written as an expression that works', () => {
  const written = [
    [motion({}), '100 + 8 * smooth(bass, 0.05, 0.5)'],
    [motion({ amount: -2.5, source: 'highs', speed: 'snappy' }), '100 - 2.5 * smooth(highs, 0.02, 0.2)'],
    [motion({ source: 'beat', speed: 'slow' }), '100 + 8 * smooth(beat, 0, 0.8)'],
    [motion({ source: 'wave', period: 12 }), '100 + 8 * sine(time / 12)'],
    [motion({ base: 0.5, amount: 0.25, source: 'wander', period: 3 }), '0.5 + 0.25 * noise(time / 3)'],
  ] as const;
  for (const [given, text] of written) {
    assert.equal(motionExpression(given), text);
    assert.ok(compile(text, MUSIC_NAMES, 'number').ok, text);
  }
});

test('an expression written that way is read back, and any other is not', () => {
  for (const given of [motion({}), motion({ amount: -3, source: 'level', speed: 'slow' }), motion({ source: 'beat', speed: 'snappy' }), motion({ source: 'wave', period: 4 })]) {
    const back = parseMotion(motionExpression(given))!;
    assert.deepEqual({ ...back, period: given.source === 'wave' ? back.period : given.period }, given);
  }
  assert.equal(parseMotion('13 + 4 * beat'), null);
  assert.equal(parseMotion('100 + 8 * smooth(bass, 0.07, 0.5)'), null);
  assert.equal(parseMotion('100 + 8 * smooth(sparkle, 0.05, 0.5)'), null);
});
