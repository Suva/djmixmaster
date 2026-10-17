// ZIP files, as much of them as a template file needs: written with every
// entry stored as it is (videos and pictures are compressed already), and in
// the ZIP64 form where an entry or the file is past 4 GB; read whether stored
// or deflated, so that a template unpacked and packed again with Finder or
// Explorer still opens. Files go in and out as streams: a video is never
// held in memory whole.

import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw, inflateRawSync } from 'node:zlib';

/** What goes into a ZIP: a file from disk, or bytes. */
export type ZipEntry = { name: string; path: string } | { name: string; data: Uint8Array };

/** An entry as found in a ZIP. */
export interface ZipItem {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  size: number;
  packedSize: number;
  /** Where its local header is. */
  offset: number;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
/** Past this, a size or an offset needs ZIP64. */
const MOST = 0xffffffff;
/** "Made by" and "needed": version 4.5, which has ZIP64; names in UTF-8 (bit 11). */
const VERSION = 45;
const UTF8 = 0x0800;

async function crcOfFile(path: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(path)) crc = crc32(chunk as Buffer, crc);
  return crc;
}

/** Writes a ZIP of these entries, each stored as it is. */
export async function writeZip(output: string, entries: ZipEntry[]): Promise<void> {
  const out = createWriteStream(output);
  const closed = new Promise<void>((done, fail) => {
    out.on('finish', done);
    out.on('error', fail);
  });
  let offset = 0;
  const write = (bytes: Uint8Array) =>
    new Promise<void>((done, fail) => {
      offset += bytes.length;
      out.write(bytes, (error) => (error ? fail(error) : done()));
    });
  const central: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const size = 'data' in entry ? entry.data.length : (await stat(entry.path)).size;
    const crc = 'data' in entry ? crc32(entry.data) : await crcOfFile(entry.path);
    const at = offset;
    const big = size >= MOST;
    // The local header: sizes in a ZIP64 extra field when too large for their own.
    const localExtra = big ? zip64Extra([size, size]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // no time
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(big ? MOST : size, 18);
    local.writeUInt32LE(big ? MOST : size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    await write(Buffer.concat([local, name, localExtra]));
    if ('data' in entry) await write(entry.data);
    else for await (const chunk of createReadStream(entry.path)) await write(chunk as Buffer);

    const far = at >= MOST;
    const extra = big || far ? zip64Extra([...(big ? [size, size] : []), ...(far ? [at] : [])]) : Buffer.alloc(0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(VERSION, 6);
    header.writeUInt16LE(UTF8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(big ? MOST : size, 20);
    header.writeUInt32LE(big ? MOST : size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(far ? MOST : at, 42);
    central.push(header, name, extra);
  }
  const directory = Buffer.concat(central);
  const directoryAt = offset;
  await write(directory);
  if (directoryAt >= MOST || directory.length >= MOST || entries.length >= 0xffff) {
    const end64At = offset;
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(END64, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(VERSION, 12);
    end64.writeUInt16LE(VERSION, 14);
    end64.writeBigUInt64LE(BigInt(entries.length), 24);
    end64.writeBigUInt64LE(BigInt(entries.length), 32);
    end64.writeBigUInt64LE(BigInt(directory.length), 40);
    end64.writeBigUInt64LE(BigInt(directoryAt), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(LOCATOR64, 0);
    locator.writeBigUInt64LE(BigInt(end64At), 8);
    locator.writeUInt32LE(1, 16);
    await write(Buffer.concat([end64, locator]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(Math.min(0xffff, entries.length), 8);
  end.writeUInt16LE(Math.min(0xffff, entries.length), 10);
  end.writeUInt32LE(Math.min(MOST, directory.length), 12);
  end.writeUInt32LE(Math.min(MOST, directoryAt), 16);
  await write(end);
  out.end();
  await closed;
}

/** The ZIP64 extra field holding these values, in the order the format gives them. */
function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + 8 * values.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, i) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * i));
  return extra;
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  return bytes.subarray(0, bytesRead);
}

/** Whether a file is a ZIP, by its first bytes. */
export async function isZip(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    return (await readAt(file, 0, 4)).readUInt32LE(0) === LOCAL;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

/** The entries of a ZIP, from its central directory. */
export async function readZip(path: string): Promise<ZipItem[]> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    // The end record is in the last 22 bytes, or before a comment of up to 64 KB.
    const tailAt = Math.max(0, size - 22 - 0xffff);
    const tail = await readAt(file, tailAt, size - tailAt);
    let at = tail.length - 22;
    while (at >= 0 && tail.readUInt32LE(at) !== END) at--;
    if (at < 0) throw new Error('Not a ZIP file');
    let count = tail.readUInt16LE(at + 10);
    let directorySize = tail.readUInt32LE(at + 12);
    let directoryAt = tail.readUInt32LE(at + 16);
    if (at >= 20 && tail.readUInt32LE(at - 20) === LOCATOR64) {
      const end64 = await readAt(file, Number(tail.readBigUInt64LE(at - 20 + 8)), 56);
      if (end64.readUInt32LE(0) !== END64) throw new Error('A damaged ZIP file');
      count = Number(end64.readBigUInt64LE(32));
      directorySize = Number(end64.readBigUInt64LE(40));
      directoryAt = Number(end64.readBigUInt64LE(48));
    }
    const directory = await readAt(file, directoryAt, directorySize);
    const items: ZipItem[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (directory.readUInt32LE(p) !== CENTRAL) throw new Error('A damaged ZIP file');
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      let packedSize = directory.readUInt32LE(p + 20);
      let itemSize = directory.readUInt32LE(p + 24);
      let offset = directory.readUInt32LE(p + 42);
      const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
      // Values too large for their own place are in the ZIP64 extra field, in order.
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = directory.readUInt16LE(e);
        const length = directory.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let v = e + 4;
          const next = () => {
            const value = Number(directory.readBigUInt64LE(v));
            v += 8;
            return value;
          };
          if (itemSize === MOST) itemSize = next();
          if (packedSize === MOST) packedSize = next();
          if (offset === MOST) offset = next();
        }
        e += 4 + length;
      }
      items.push({ name, method: directory.readUInt16LE(p + 10), size: itemSize, packedSize, offset });
      p = extraEnd + commentLength;
    }
    return items;
  } finally {
    await file.close();
  }
}

/** Where an entry's data starts, past its local header. */
async function dataAt(file: FileHandle, item: ZipItem): Promise<number> {
  const local = await readAt(file, item.offset, 30);
  if (local.readUInt32LE(0) !== LOCAL) throw new Error('A damaged ZIP file');
  return item.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
}

function checkMethod(item: ZipItem) {
  if (item.method !== 0 && item.method !== 8) throw new Error(`${item.name} is packed in a way the app cannot read`);
}

/** An entry's bytes, for a small one. */
export async function readZipEntry(path: string, item: ZipItem): Promise<Buffer> {
  checkMethod(item);
  const file = await open(path, 'r');
  try {
    const packed = await readAt(file, await dataAt(file, item), item.packedSize);
    return item.method === 8 ? inflateRawSync(packed) : packed;
  } finally {
    await file.close();
  }
}

/** Writes an entry out to a file of its own, as a stream. */
export async function extractZipEntry(path: string, item: ZipItem, output: string): Promise<void> {
  checkMethod(item);
  const file = await open(path, 'r');
  let start: number;
  try {
    start = await dataAt(file, item);
  } finally {
    await file.close();
  }
  if (item.packedSize === 0) {
    await pipeline(async function* () {}, createWriteStream(output));
    return;
  }
  const packed = createReadStream(path, { start, end: start + item.packedSize - 1 });
  if (item.method === 8) await pipeline(packed, createInflateRaw(), createWriteStream(output));
  else await pipeline(packed, createWriteStream(output));
}
