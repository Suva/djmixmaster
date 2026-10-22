// Where playback is heard: the output chosen in Settings, found among the
// devices the computer has now. A device that is not plugged in is not
// forgotten: playback goes to the system's default meanwhile, and back to the
// device as soon as it is there again.

import type { AudioOutput } from '../api.ts';

/** An output device as the window lists it. */
export interface OutputDevice {
  id: string;
  name: string;
}

/** The devices sound can be played through, without the system's stand-in for its default. */
export async function outputDevices(): Promise<OutputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audiooutput' && device.deviceId !== 'default' && device.deviceId !== '')
    .map((device) => ({ id: device.deviceId, name: device.label || 'Unnamed output' }));
}

/** The system's default output, by name, as its stand-in in the list says. */
export async function defaultOutputName(): Promise<string | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const stand = devices.find((device) => device.kind === 'audiooutput' && device.deviceId === 'default');
  return stand?.label ? stand.label.replace(/^Default - /, '') : null;
}

/**
 * The device to play through for a choice: the one with its id, or else one
 * with its name, as an id can change when a device is plugged into another
 * port. Null when it is not there.
 */
export function deviceFor(choice: AudioOutput, devices: OutputDevice[]): OutputDevice | null {
  return devices.find((device) => device.id === choice.id) ?? devices.find((device) => device.name === choice.name) ?? null;
}

/**
 * Keeps the player on the chosen output as devices come and go, and says so
 * when it has to fall back or can go back.
 */
export class OutputFollower {
  #choice: AudioOutput | null = null;
  /** Whether the chosen device was missing last time, so that its return is told. */
  #missing = false;
  readonly #apply: (id: string) => Promise<void>;
  readonly #say: (text: string) => void;

  constructor(apply: (id: string) => Promise<void>, say: (text: string) => void) {
    this.#apply = apply;
    this.#say = say;
    navigator.mediaDevices.addEventListener('devicechange', () => void this.#follow(true));
  }

  get choice(): AudioOutput | null {
    return this.#choice;
  }

  /** Whether the chosen device is missing, and the default is heard instead. */
  get missing(): boolean {
    return this.#missing;
  }

  async choose(choice: AudioOutput | null) {
    this.#choice = choice;
    this.#missing = false;
    await this.#follow(false);
  }

  async #follow(changed: boolean) {
    const choice = this.#choice;
    if (!choice) return this.#apply('');
    const device = deviceFor(choice, await outputDevices());
    try {
      await this.#apply(device?.id ?? '');
    } catch {
      // A device that went away between the list and the switch: as if it were not there.
      await this.#apply('');
      if (!this.#missing) this.#say(`“${choice.name}” could not be used. Playing through the system's default output.`);
      this.#missing = true;
      return;
    }
    if (!device && !this.#missing) this.#say(`“${choice.name}” is not connected. Playing through the system's default output until it is.`);
    else if (device && this.#missing && changed) this.#say(`Playing through “${choice.name}” again.`);
    this.#missing = !device;
  }
}
