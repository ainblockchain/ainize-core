/**
 * Minimal NumPy .npz reader — enough to read a knowledge patch:
 *   addrs: int64[N], before: float32[N, D], after: float32[N, D]
 * Supports ZIP_STORED and ZIP_DEFLATED members. Reads only what is asked for,
 * so a 350 MB patch can be inspected (row count, address set) cheaply.
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

function readCentralDirectory(fd: number, fileSize: number): ZipEntry[] {
  // End of central directory record: search last 64KB+22 bytes for signature 0x06054b50.
  const tailLen = Math.min(fileSize, 65557);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('npz: end of central directory not found');
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let total = tail.readUInt16LE(eocd + 10);
  // ZIP64?
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || total === 0xffff) {
    const locIdx = eocd - 20;
    if (locIdx >= 0 && tail.readUInt32LE(locIdx) === 0x07064b50) {
      const z64Off = Number(tail.readBigUInt64LE(locIdx + 8));
      const z64 = readAt(fd, z64Off, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('npz: bad zip64 eocd');
      total = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < total && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // zip64 extra field
    let ep = p + 46 + nameLen;
    const extraEnd = ep + extraLen;
    while (ep + 4 <= extraEnd) {
      const id = cd.readUInt16LE(ep);
      const sz = cd.readUInt16LE(ep + 2);
      if (id === 0x0001) {
        let q = ep + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      ep += 4 + sz;
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(fd: number, e: ZipEntry): Buffer {
  const lh = readAt(fd, e.localHeaderOffset, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('npz: bad local header');
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const start = e.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = readAt(fd, start, e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`npz: unsupported compression method ${e.method}`);
}

export interface NpyHeader {
  descr: string;
  fortranOrder: boolean;
  shape: number[];
  dataOffset: number;
}

export function parseNpyHeader(buf: Buffer): NpyHeader {
  if (buf.subarray(0, 6).toString('latin1') !== '\x93NUMPY') throw new Error('npy: bad magic');
  const major = buf[6];
  let headerLen: number;
  let off: number;
  if (major === 1) { headerLen = buf.readUInt16LE(8); off = 10; }
  else { headerLen = buf.readUInt32LE(8); off = 12; }
  const header = buf.subarray(off, off + headerLen).toString('latin1');
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? '';
  const fortranOrder = /'fortran_order':\s*(True|False)/.exec(header)?.[1] === 'True';
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  const shape = shapeStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  return { descr, fortranOrder, shape, dataOffset: off + headerLen };
}

export interface NpzInfo {
  members: { name: string; descr: string; shape: number[]; bytes: number }[];
  rows: number;
  rowDim: number;
}

/** Inspect an .npz without loading array bodies (except headers). */
export function inspectNpz(path: string): NpzInfo {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const entries = readCentralDirectory(fd, size);
    const members = entries.map((e) => {
      // Only need the first ~256 bytes for the header; stored members can be sliced, deflated must be inflated.
      let head: Buffer;
      if (e.method === 0) {
        const lh = readAt(fd, e.localHeaderOffset, 30);
        const nameLen = lh.readUInt16LE(26); const extraLen = lh.readUInt16LE(28);
        head = readAt(fd, e.localHeaderOffset + 30 + nameLen + extraLen, Math.min(e.uncompressedSize, 4096));
      } else {
        head = entryData(fd, e).subarray(0, 4096);
      }
      const h = parseNpyHeader(head);
      return { name: e.name.replace(/\.npy$/, ''), descr: h.descr, shape: h.shape, bytes: e.uncompressedSize };
    });
    const addrs = members.find((m) => m.name === 'addrs');
    const after = members.find((m) => m.name === 'after');
    return {
      members,
      rows: addrs?.shape[0] ?? 0,
      rowDim: after?.shape[1] ?? 0,
    };
  } finally {
    closeSync(fd);
  }
}

/** Load the int64 address array as BigInt64Array (copy). */
export function readNpzAddrs(path: string): BigInt64Array {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const entries = readCentralDirectory(fd, size);
    const e = entries.find((x) => x.name === 'addrs.npy');
    if (!e) throw new Error('npz: no addrs member');
    const data = entryData(fd, e);
    const h = parseNpyHeader(data);
    if (!/^[<|=]i8$/.test(h.descr)) throw new Error(`npz: addrs dtype ${h.descr} unsupported (expected int64)`);
    const body = data.subarray(h.dataOffset);
    const aligned = Buffer.alloc(body.length);
    body.copy(aligned);
    return new BigInt64Array(aligned.buffer, aligned.byteOffset, body.length / 8);
  } finally {
    closeSync(fd);
  }
}

/** Sorted, de-duplicated address set. */
export function addressSet(addrs: BigInt64Array): BigInt64Array {
  const copy = BigInt64Array.from(addrs);
  copy.sort();
  let w = 0;
  for (let i = 0; i < copy.length; i++) {
    if (i === 0 || copy[i] !== copy[i - 1]) copy[w++] = copy[i];
  }
  return copy.subarray(0, w);
}

/** |A ∩ B| for two sorted address sets (도 6 conflict test). */
export function intersectionCount(a: BigInt64Array, b: BigInt64Array): number {
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

/** Bottom-k MinHash-style sketch of an address set for cheap remote pre-checks. */
export function addressSketch(addrs: BigInt64Array, k = 64): number[] {
  // Mix with a fixed 64-bit multiplier and keep the k smallest 32-bit values.
  const MUL = 0x9e3779b97f4a7c15n;
  const MASK = (1n << 64n) - 1n;
  const heap: number[] = [];
  for (const a of addrs) {
    const h = Number(((BigInt.asUintN(64, a) * MUL) & MASK) >> 32n);
    if (heap.length < k) { heap.push(h); if (heap.length === k) heap.sort((x, y) => x - y); }
    else if (h < heap[k - 1]) {
      let pos = k - 1;
      while (pos > 0 && heap[pos - 1] > h) { heap[pos] = heap[pos - 1]; pos--; }
      heap[pos] = h;
    }
  }
  return heap.length < k ? heap.sort((x, y) => x - y) : heap;
}

/** Estimated Jaccard similarity from two bottom-k sketches. */
export function sketchJaccard(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const k = Math.min(a.length, b.length);
  const union = Array.from(new Set([...a, ...b])).sort((x, y) => x - y).slice(0, k);
  const setB = new Set(b);
  let both = 0;
  for (const v of union) if (a.includes(v) && setB.has(v)) both++;
  return both / k;
}
