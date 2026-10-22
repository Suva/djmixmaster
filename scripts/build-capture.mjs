// Builds the capture helper (native/capture/capture.c) for this system, into
// native/capture/build/. It needs a C compiler: Xcode's command line tools on
// macOS, Visual Studio's (cl) or MinGW's gcc on Windows, gcc or clang on
// Linux. miniaudio comes with the source, so nothing else is needed.
//
//   node scripts/build-capture.mjs [folder]
//
// A folder given builds it there instead, as the test of the build does, so as not to replace the one in use.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const source = 'native/capture/capture.c';
const folder = process.argv[2] ?? 'native/capture/build';
mkdirSync(folder, { recursive: true });
const windows = process.platform === 'win32';
const output = join(folder, windows ? 'djm-capture.exe' : 'djm-capture');

const has = (program) => spawnSync(windows ? 'where' : 'which', [program], { stdio: 'ignore' }).status === 0;

/** Compiles with `compiler`; gives what went wrong, or null. */
function compile(compiler, args, env = process.env) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', env });
  return result.status === 0 ? null : `${result.stderr}${result.stdout}`.trim();
}

let failure;
if (process.platform === 'darwin') {
  // miniaudio reaches Core Audio by loading it while running, so nothing is linked but the C library.
  const args = ['-O2', '-std=c11', '-mmacosx-version-min=11.0', '-o', output, source, '-lpthread', '-lm'];
  failure = compile('cc', args);
  // A set of command line tools can come with an SDK newer than its own linker reads; an older one does as well.
  if (failure && /tapi error|unknown architecture/.test(failure)) {
    const sdks = '/Library/Developer/CommandLineTools/SDKs';
    const older = existsSync(sdks) ? readdirSync(sdks).filter((name) => /^MacOSX\d+\.\d+\.sdk$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
    for (const sdk of older) {
      failure = compile('cc', args, { ...process.env, SDKROOT: join(sdks, sdk) });
      if (!failure) break;
    }
  }
} else if (windows) {
  failure = has('cl')
    ? compile('cl', ['/nologo', '/O2', '/W3', `/Fe:${output}`, `/Fo:${folder}\\`, source, 'ole32.lib'])
    // Linked statically, so that the program needs none of MinGW's own libraries beside it.
    : compile('gcc', ['-O2', '-std=c11', '-static', '-o', output, source, '-lole32', '-lm']);
} else {
  failure = compile('cc', ['-O2', '-std=c11', '-o', output, source, '-ldl', '-lpthread', '-lm']);
}

if (failure) {
  console.error(`The capture helper could not be built:\n${failure}`);
  process.exit(1);
}
console.log(`Built ${output}: ${execFileSync(output, ['list'], { encoding: 'utf8' }).trim().length > 0 ? 'it lists the inputs' : 'it runs'}.`);
