// The capture helper (native/capture/capture.c) builds on this system and
// answers. Recording itself needs a device, which a test machine may not have;
// that was tried by hand with a loopback device (see TASKS.md).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const windows = process.platform === 'win32';
const compiler = windows ? ['cl', 'gcc'] : ['cc'];
const found = compiler.some((name) => spawnSync(windows ? 'where' : 'which', [name], { stdio: 'ignore' }).status === 0);
const skip = found ? false : 'No C compiler here';

test('the capture helper builds, and lists the inputs as JSON', { skip, timeout: 120_000 }, () => {
  execFileSync(process.execPath, ['scripts/build-capture.mjs'], { stdio: 'pipe' });
  const helper = join('native/capture/build', windows ? 'djm-capture.exe' : 'djm-capture');
  const result = spawnSync(helper, ['list'], { encoding: 'utf8' });
  // A machine without sound can have nothing to list, or no sound system at all to ask; either way it says so in JSON.
  if (result.status === 0) {
    const inputs = JSON.parse(result.stdout);
    assert.ok(Array.isArray(inputs));
    for (const input of inputs) {
      assert.match(input.id, /^[0-9a-f]+$/);
      assert.equal(typeof input.name, 'string');
      assert.ok(Number.isInteger(input.channels));
    }
  } else {
    assert.ok('error' in JSON.parse(result.stderr.trim().split('\n').at(-1)!));
  }
  // Asked for what it does not do, it says how it is used.
  assert.match(spawnSync(helper, [], { encoding: 'utf8' }).stderr, /^Usage: djm-capture list/);
});
