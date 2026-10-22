// The hidden page that captures an audio input, for the Record view's meters
// and for recording (recorder.ts). Chromium's capture rather than ffmpeg's:
// ffmpeg's on macOS keeps a single buffer of sound waiting, and drops one
// whenever it is read a moment late, a tenth of everything on a laptop. This
// takes all of it, but at most two channels of a device. The main process
// calls `window.capture` and is sent the samples.

import type { Api } from '../api.ts';

declare global {
  interface Window {
    api: Api;
    capture: Capture;
  }
}

/** A tone on each side, at levels of their own, for checks: the stand-in for every device in check mode. */
const TEST_TONES = [[440, 0.5], [550, 0.25]] as const;
const TEST_RATE = 48000;

interface Capture {
  devices(): Promise<{ name: string }[]>;
  /** Opens a device by its name, or for checks a test signal of one channel or two. */
  start(device: string, test: 'mono' | 'stereo' | false): Promise<{ channels: number; sampleRate: number }>;
  stop(): Promise<void>;
}

let context: AudioContext | null = null;
let stream: MediaStream | null = null;

async function stop() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  await context?.close().catch(() => {});
  context = null;
}

window.capture = {
  async devices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // The system's own stand-ins for whatever is its default are left out: a recording is of a device chosen by name.
    return devices
      .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications')
      .map((device) => ({ name: device.label || 'Unnamed input' }));
  },

  async start(device, test) {
    await stop();
    let source: AudioNode;
    let channels: number;
    let rate: number;
    if (test) {
      rate = TEST_RATE;
      channels = test === 'mono' ? 1 : 2;
      context = new AudioContext({ sampleRate: rate, sinkId: { type: 'none' } } as AudioContextOptions);
      const merger = new ChannelMergerNode(context, { numberOfInputs: channels });
      TEST_TONES.slice(0, channels).forEach(([hz, level], c) => {
        const tone = new OscillatorNode(context!, { frequency: hz });
        tone.connect(new GainNode(context!, { gain: level })).connect(merger, 0, c);
        tone.start();
      });
      source = merger;
    } else {
      const found = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label === device);
      if (!found) throw new Error(`“${device}” is not connected.`);
      // The sound as the device gives it: none of what a call would want done to a voice.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: found.deviceId }, channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      channels = Math.max(1, Math.min(2, settings.channelCount ?? 2));
      rate = settings.sampleRate ?? 48000;
      // At the device's own rate, so that nothing is resampled; heard by nothing.
      context = new AudioContext({ sampleRate: rate, sinkId: { type: 'none' } } as AudioContextOptions);
      track.addEventListener('ended', () => window.api.captureEnded(`“${device}” went away.`));
      source = context.createMediaStreamSource(stream);
    }
    await context.audioWorklet.addModule('capture-worklet.js');
    const node = new AudioWorkletNode(context, 'capture', {
      channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      numberOfOutputs: 0, processorOptions: { channels },
    });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => window.api.captureSamples(event.data);
    source.connect(node);
    return { channels, sampleRate: context.sampleRate };
  },

  stop,
};
