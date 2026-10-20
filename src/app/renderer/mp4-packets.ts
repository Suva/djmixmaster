// Reads the compressed frames of a video out of the fragmented MP4 that ffmpeg
// writes for an export (see serveClip in main.ts), for the browser's video
// decoder: what the decoder needs to know to start, then each frame as a
// packet with its time. Only what that MP4 holds is read: one video track, a
// fragment per frame or a few, the boxes ffmpeg writes.
//
// Kept free of Node imports: the export page uses it, and so do the tests.

/** What a decoder needs to know of a clip's track to decode it. */
export interface Mp4Track {
  /** As WebCodecs names it, such as "avc1.640028". */
  codec: string;
  /** The codec's own setup: the avcC or hvcC box, and so on; none for VP9. */
  description?: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  colorSpace?: VideoColorSpaceInit;
}

/** A compressed frame, in decoding order, with when it is shown. */
export interface Mp4Packet {
  /** When it is shown, in microseconds of the clip's own time. */
  timestamp: number;
  duration: number;
  key: boolean;
  data: Uint8Array;
}

interface Box {
  type: string;
  /** Where its contents begin and end, in the bytes it was read from. */
  start: number;
  end: number;
}

/** The boxes in `bytes` from `start` to `end`, one after another. */
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    found.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return found;
}

const child = (bytes: Uint8Array, box: Box | undefined, type: string, skip = 0) =>
  box ? boxes(bytes, box.start + skip, box.end).find((inner) => inner.type === type) : undefined;

/** The box at the end of a path of box types, from the top. */
function find(bytes: Uint8Array, top: Box, ...path: string[]): Box | undefined {
  let box: Box | undefined = top;
  for (const type of path) box = child(bytes, box, type);
  return box;
}

const hex = (value: number) => value.toString(16).padStart(2, '0');
/** VP9 and AV1 codec strings give their numbers in decimal, two digits each. */
const two = (value: number) => String(value).padStart(2, '0');

/** The codec string of a sample entry, as WebCodecs wants it, from the box that sets the codec up. */
export function codecString(entry: string, setup: Uint8Array | undefined): string | null {
  if (!setup) return null;
  if (entry === 'avc1' || entry === 'avc3') {
    // avcC: version, then the profile, its compatibility and the level.
    return `avc1.${hex(setup[1])}${hex(setup[2])}${hex(setup[3])}`;
  }
  if (entry === 'hvc1' || entry === 'hev1') {
    // hvcC: profile space, tier and profile; 32 bits of compatibility; six bytes of constraints; the level.
    const space = ['', 'A', 'B', 'C'][setup[1] >> 6];
    const tier = setup[1] & 0x20 ? 'H' : 'L';
    const profile = setup[1] & 0x1f;
    let compatibility = (setup[2] << 24) | (setup[3] << 16) | (setup[4] << 8) | setup[5];
    let reversed = 0;
    for (let i = 0; i < 32; i++) {
      reversed = (reversed << 1) | (compatibility & 1);
      compatibility >>>= 1;
    }
    const constraints = [...setup.subarray(6, 12)];
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    const upper = (value: number) => value.toString(16).toUpperCase();
    return [`${entry}.${space}${profile}`, upper(reversed >>> 0), `${tier}${setup[12]}`, ...constraints.map(upper)].join('.');
  }
  if (entry === 'vp09') {
    // vpcC, a full box: the profile, the level, and the bit depth in the top four bits.
    return `vp09.${two(setup[4])}.${two(setup[5])}.${two(setup[6] >> 4)}`;
  }
  if (entry === 'av01') {
    // av1C: the profile and level, then the tier and the bit depth.
    const profile = setup[1] >> 5;
    const level = setup[1] & 0x1f;
    const tier = setup[2] & 0x80 ? 'H' : 'M';
    const depth = setup[2] & 0x40 ? (setup[2] & 0x20 ? 12 : 10) : 8;
    return `av01.${profile}.${two(level)}${tier}.${two(depth)}`;
  }
  return null;
}

/** The box setting each kind of sample entry's codec up. */
const SETUP: Record<string, string> = { avc1: 'avcC', avc3: 'avcC', hvc1: 'hvcC', hev1: 'hvcC', vp09: 'vpcC', av01: 'av1C' };

// Colour as an MP4's colr box gives it (ISO/IEC 23091-2 numbers), as WebCodecs names it.
// TypeScript's own lists of these names are shorter than the browser's.
const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFERS: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
const MATRICES: Record<number, string> = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };

interface Defaults {
  duration: number;
  size: number;
  flags: number;
}

/** A sample's flags say it depends on no other: a keyframe. */
const isKey = (flags: number) => (flags & 0x10000) === 0;

/**
 * Reads a fragmented MP4 as it arrives: `push` the bytes in, then take what
 * they completed. The first thing out is the track, once the moov box is in;
 * after it, packets, as each fragment's media comes in.
 */
export class Mp4Reader {
  /** Bytes in, of which those from `#start` to `#end` are not read yet: room grows as boxes need it, without copying all of it on every push. */
  #buffer = new Uint8Array(1 << 16);
  #start = 0;
  #end = 0;
  #timescale = 1;
  /** The track's start in its own time units, from its edit list: shown times are counted from it. */
  #shift = 0;
  #defaults: Defaults = { duration: 0, size: 0, flags: 0 };
  /** The samples of the last moof, waiting for the mdat that holds them: offsets from the moof's first byte. */
  #samples: { offset: number; size: number; dts: number; cto: number; duration: number; flags: number }[] = [];
  /** How far the last moof's first byte lies before the next box read: its samples are placed from it. */
  #sinceMoof = 0;
  #out: (Mp4Track | Mp4Packet)[] = [];

  push(bytes: Uint8Array) {
    if (this.#end + bytes.length > this.#buffer.length) {
      const unread = this.#end - this.#start;
      const room = unread + bytes.length > this.#buffer.length / 2 ? new Uint8Array(Math.max(this.#buffer.length * 2, unread + bytes.length)) : this.#buffer;
      room.set(this.#buffer.subarray(this.#start, this.#end));
      this.#buffer = room;
      this.#start = 0;
      this.#end = unread;
    }
    this.#buffer.set(bytes, this.#end);
    this.#end += bytes.length;
    const view = new DataView(this.#buffer.buffer);
    while (this.#start + 8 <= this.#end) {
      let size = view.getUint32(this.#start);
      if (size === 1) {
        if (this.#start + 16 > this.#end) break;
        size = Number(view.getBigUint64(this.#start + 8));
      }
      if (size < 8) throw new Error('The clip\'s packets are not in a form that can be read');
      if (this.#start + size > this.#end) break;
      this.#box(this.#buffer.subarray(this.#start, this.#start + size));
      this.#start += size;
    }
    if (this.#start === this.#end) this.#start = this.#end = 0;
  }

  /** The track and packets completed so far, in order. */
  take(): (Mp4Track | Mp4Packet)[] {
    const out = this.#out;
    this.#out = [];
    return out;
  }

  #box(bytes: Uint8Array) {
    const [box] = boxes(bytes);
    if (!box) return;
    if (box.type === 'moov') this.#moov(bytes, box);
    else if (box.type === 'moof') this.#moof(bytes, box);
    else if (box.type === 'mdat') this.#mdat(bytes, box);
    this.#sinceMoof += bytes.length;
  }

  #moov(bytes: Uint8Array, moov: Box) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trak = boxes(bytes, moov.start, moov.end).find((box) => box.type === 'trak' && find(bytes, box, 'mdia', 'minf', 'vmhd'));
    if (!trak) throw new Error('The clip has no picture');
    const mdhd = find(bytes, trak, 'mdia', 'mdhd')!;
    this.#timescale = view.getUint32(mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12));
    const stsd = find(bytes, trak, 'mdia', 'minf', 'stbl', 'stsd')!;
    // stsd is a full box with a count before its entries; a visual entry has 78 bytes before its own boxes.
    const [entry] = boxes(bytes, stsd.start + 8, stsd.end);
    const width = view.getUint16(entry.start + 24);
    const height = view.getUint16(entry.start + 26);
    const inner = boxes(bytes, entry.start + 78, entry.end);
    const setupBox = inner.find((box) => box.type === SETUP[entry.type]);
    const setup = setupBox && bytes.slice(setupBox.start, setupBox.end);
    const codec = codecString(entry.type, setup);
    if (!codec) throw new Error(`The clip's codec (${entry.type}) is not one the decoder knows`);
    const track: Mp4Track = { codec, codedWidth: width, codedHeight: height };
    if (setup && entry.type !== 'vp09') track.description = setup;
    const colr = inner.find((box) => box.type === 'colr');
    if (colr && String.fromCharCode(...bytes.subarray(colr.start, colr.start + 4)) === 'nclx') {
      const primaries = PRIMARIES[view.getUint16(colr.start + 4)];
      const transfer = TRANSFERS[view.getUint16(colr.start + 6)];
      const matrix = MATRICES[view.getUint16(colr.start + 8)];
      // Only all of it: what is not said is better left to what the video itself says.
      if (primaries && transfer && matrix) {
        track.colorSpace = { primaries, transfer, matrix, fullRange: (bytes[colr.start + 10] & 0x80) !== 0 } as VideoColorSpaceInit;
      }
    }
    // An edit list that starts the track later than its first frame: ffmpeg's way of keeping
    // frames that come before where it was asked to start, and of making room for reordering.
    const elst = find(bytes, trak, 'edts', 'elst');
    this.#shift = 0;
    if (elst) {
      const version = bytes[elst.start];
      const count = view.getUint32(elst.start + 4);
      for (let i = 0, at = elst.start + 8; i < count; i++, at += version === 1 ? 20 : 12) {
        const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
        // An empty edit (-1) is a pause before the track; the first real one says where it starts.
        if (mediaTime >= 0) {
          this.#shift = mediaTime;
          break;
        }
      }
    }
    const trex = find(bytes, moov, 'mvex', 'trex');
    if (trex) this.#defaults = { duration: view.getUint32(trex.start + 12), size: view.getUint32(trex.start + 16), flags: view.getUint32(trex.start + 20) };
    this.#out.push(track);
  }

  #moof(bytes: Uint8Array, moof: Box) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#samples = [];
    this.#sinceMoof = 0;
    for (const traf of boxes(bytes, moof.start, moof.end).filter((box) => box.type === 'traf')) {
      const tfhd = child(bytes, traf, 'tfhd')!;
      const tfhdFlags = view.getUint32(tfhd.start) & 0xffffff;
      let at = tfhd.start + 8;
      // The base data offset is not used: ffmpeg writes "default-base-is-moof" and places data from the moof.
      if (tfhdFlags & 0x1) at += 8;
      if (tfhdFlags & 0x2) at += 4;
      const defaults = { ...this.#defaults };
      if (tfhdFlags & 0x8) (defaults.duration = view.getUint32(at)), (at += 4);
      if (tfhdFlags & 0x10) (defaults.size = view.getUint32(at)), (at += 4);
      if (tfhdFlags & 0x20) defaults.flags = view.getUint32(at);
      const tfdt = child(bytes, traf, 'tfdt');
      let dts = tfdt ? (bytes[tfdt.start] === 1 ? Number(view.getBigUint64(tfdt.start + 4)) : view.getUint32(tfdt.start + 4)) : 0;
      for (const trun of boxes(bytes, traf.start, traf.end).filter((box) => box.type === 'trun')) {
        const version = bytes[trun.start];
        const flags = view.getUint32(trun.start) & 0xffffff;
        const count = view.getUint32(trun.start + 4);
        let at = trun.start + 8;
        let offset = 0;
        if (flags & 0x1) (offset = view.getInt32(at)), (at += 4);
        let firstFlags: number | null = null;
        if (flags & 0x4) (firstFlags = view.getUint32(at)), (at += 4);
        for (let i = 0; i < count; i++) {
          let duration = defaults.duration;
          let size = defaults.size;
          let sampleFlags = i === 0 && firstFlags !== null ? firstFlags : defaults.flags;
          let cto = 0;
          if (flags & 0x100) (duration = view.getUint32(at)), (at += 4);
          if (flags & 0x200) (size = view.getUint32(at)), (at += 4);
          if (flags & 0x400) (sampleFlags = view.getUint32(at)), (at += 4);
          if (flags & 0x800) (cto = version === 0 ? view.getUint32(at) : view.getInt32(at)), (at += 4);
          // Offsets are from the moof box's first byte.
          this.#samples.push({ offset, size, dts, cto, duration, flags: sampleFlags });
          offset += size;
          dts += duration;
        }
      }
    }
  }

  #mdat(bytes: Uint8Array, mdat: Box) {
    // Where this mdat's first byte lies from the moof's start.
    const mdatAt = this.#sinceMoof;
    const micro = 1e6 / this.#timescale;
    for (const sample of this.#samples) {
      const from = sample.offset - mdatAt;
      if (from < mdat.start || from + sample.size > mdat.end) continue;
      this.#out.push({
        timestamp: Math.round((sample.dts + sample.cto - this.#shift) * micro),
        duration: Math.round(sample.duration * micro),
        key: isKey(sample.flags),
        data: bytes.slice(from, from + sample.size),
      });
    }
    this.#samples = [];
  }
}
