/**
 * fatImage.ts — build a FAT16 filesystem image from a set of files, in the
 * browser, with no dependencies.
 *
 * Used by the microSD card feature: the auto-copy of project files (free) and
 * the "SD Card" upload (paid) both produce a `{ name, data }[]` list that this
 * turns into a `Uint8Array` disk image. That image is handed to the
 * `microsd-card` simulation part via `element.sdImageData`, where the firmware
 * mounts it over SD-over-SPI and reads the files with `SD.open(...)`.
 *
 * Layout: "super-floppy" FAT16 (BPB at sector 0, no MBR) — SdFat / the Arduino
 * SD library mount this directly. 512-byte sectors, 1 sector per cluster, 2
 * FATs, 512 root entries. Short (8.3) names are emitted directly; names that do
 * not fit 8.3 get a generated 8.3 alias plus VFAT long-name (LFN) entries so the
 * real filename is preserved.
 *
 * Scope: root directory only (flat). Subdirectories (folder trees) are a later
 * enhancement.
 */

export interface SdFile {
  /** File name (no leading slash). Long names are preserved via LFN. */
  name: string;
  data: Uint8Array;
}

const SEC = 512;

function writeU16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}
function writeU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
  buf[off + 2] = (v >> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}
function writeAscii(buf: Uint8Array, off: number, s: string, len: number, pad = 0x20): void {
  for (let i = 0; i < len; i++) buf[off + i] = i < s.length ? s.charCodeAt(i) & 0xff : pad;
}

/** Is `name` a valid uppercase-able 8.3 short name (no LFN needed)? */
function fitsShort(name: string): boolean {
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot + 1);
  if (base.length === 0 || base.length > 8 || ext.length > 3) return false;
  return /^[A-Za-z0-9_~!#$%&'()@^{}-]+$/.test(base) && /^[A-Za-z0-9_~!#$%&'()@^{}-]*$/.test(ext);
}

/** Build the 11-byte padded 8.3 representation ("HELLO   TXT"). */
function pad83(base: string, ext: string): string {
  const b = (base.toUpperCase() + '        ').slice(0, 8);
  const e = (ext.toUpperCase() + '   ').slice(0, 3);
  return b + e;
}

function sanitize83(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9_~!#$%&'()@^{}-]/g, '_');
}

/** Generate a unique 11-char 8.3 name for `name`, tracking collisions. */
function shortNameFor(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const baseRaw = dot < 0 ? name : name.slice(0, dot);
  const extRaw = dot < 0 ? '' : name.slice(dot + 1);
  const ext = sanitize83(extRaw).slice(0, 3);

  if (fitsShort(name)) {
    const s = pad83(sanitize83(baseRaw), ext);
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
  // Generated alias: BBBBBB~N.EXT
  const baseSan = sanitize83(baseRaw).replace(/~/g, '_') || 'FILE';
  for (let n = 1; n < 1_000_000; n++) {
    const suffix = '~' + n;
    const stem = (baseSan.slice(0, 8 - suffix.length) + suffix).slice(0, 8);
    const s = pad83(stem, ext);
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
  throw new Error('fatImage: could not allocate a unique short name for ' + name);
}

/** LFN checksum of the 11-byte short name. */
function lfnChecksum(short11: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + short11.charCodeAt(i)) & 0xff;
  return sum;
}

export interface BuildFatOptions {
  /** Volume size in bytes. Default 8 MB (mirrors Wokwi). */
  volumeBytes?: number;
  /** 11-char volume label. */
  label?: string;
}

/** A file listed out of a FAT16 image by `readFat16Image`. */
export interface FatDirFile {
  /** Long name when LFN entries were present, else the 8.3 name. */
  name: string;
  size: number;
  data: Uint8Array;
}

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}
function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/**
 * List the ROOT directory of a FAT16 "super-floppy" image and extract each
 * file's bytes — the inverse of `buildFat16Image`, but general enough for a
 * card a guest OS (FatFs / Arduino SD) has written to: it follows real
 * cluster chains, honours sectors-per-cluster from the BPB, decodes VFAT
 * long names and skips deleted/volume/directory entries. Subdirectories are
 * not descended (the builder is root-only too).
 *
 * Returns [] for anything that does not look like a mountable FAT16 volume —
 * the caller treats that as "no readable card", never as an error.
 */
export function readFat16Image(img: Uint8Array): FatDirFile[] {
  try {
    if (img.length < SEC || img[510] !== 0x55 || img[511] !== 0xaa) return [];
    const bytesPerSec = readU16(img, 11);
    const spc = img[13];
    const reserved = readU16(img, 14);
    const numFats = img[16];
    const rootEntries = readU16(img, 17);
    const fatSz = readU16(img, 22);
    if (!bytesPerSec || !spc || !reserved || !numFats || !fatSz || !rootEntries) return [];

    const fatStart = reserved * bytesPerSec;
    const rootStart = (reserved + numFats * fatSz) * bytesPerSec;
    const rootBytes = rootEntries * 32;
    const dataStart = rootStart + Math.ceil(rootBytes / bytesPerSec) * bytesPerSec;
    const clusterBytes = spc * bytesPerSec;
    if (dataStart >= img.length) return [];

    const out: FatDirFile[] = [];
    // LFN entries accumulate (in on-disk reverse order) until their 8.3 entry.
    let lfnParts: Array<{ seq: number; chars: string }> = [];

    for (let slot = 0; slot < rootEntries; slot++) {
      const d = rootStart + slot * 32;
      if (d + 32 > img.length) break;
      const first = img[d];
      if (first === 0x00) break; // end of directory
      if (first === 0xe5) {
        lfnParts = []; // deleted entry
        continue;
      }
      const attr = img[d + 11];
      if ((attr & 0x0f) === 0x0f) {
        // VFAT long-name entry: 13 UTF-16 chars in fixed slots.
        const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
        let chars = '';
        for (const s of slots) {
          const code = img[d + s] | (img[d + s + 1] << 8);
          if (code === 0x0000 || code === 0xffff) break;
          chars += String.fromCharCode(code);
        }
        lfnParts.push({ seq: img[d] & 0x1f, chars });
        continue;
      }
      if (attr & 0x08 || attr & 0x10) {
        // volume label / directory
        lfnParts = [];
        continue;
      }

      let name: string;
      if (lfnParts.length) {
        name = lfnParts
          .sort((a, b) => a.seq - b.seq)
          .map((p) => p.chars)
          .join('');
      } else {
        const base = String.fromCharCode(...img.subarray(d, d + 8)).trimEnd();
        const ext = String.fromCharCode(...img.subarray(d + 8, d + 11)).trimEnd();
        name = ext ? `${base}.${ext}` : base;
      }
      lfnParts = [];

      const size = readU32(img, d + 28);
      let cluster = readU16(img, d + 26);
      const data = new Uint8Array(size);
      let got = 0;
      // Follow the chain; guard against loops with a step cap.
      for (let steps = 0; got < size && cluster >= 2 && cluster < 0xfff8; steps++) {
        if (steps > 1_000_000) break;
        const at = dataStart + (cluster - 2) * clusterBytes;
        if (at >= img.length) break;
        const take = Math.min(clusterBytes, size - got, img.length - at);
        data.set(img.subarray(at, at + take), got);
        got += take;
        cluster = readU16(img, fatStart + cluster * 2);
      }
      out.push({ name, size, data: got === size ? data : data.subarray(0, got) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build a FAT16 image containing `files` in the root directory.
 * Throws if the files don't fit the volume or the root directory.
 */
export function buildFat16Image(files: SdFile[], opts: BuildFatOptions = {}): Uint8Array {
  const volumeBytes = opts.volumeBytes ?? 8 * 1024 * 1024;
  const totalSectors = Math.floor(volumeBytes / SEC);
  const spc = 1; // sectors per cluster
  const reserved = 1;
  const numFats = 2;
  const rootEntries = 512;
  const rootDirSectors = Math.ceil((rootEntries * 32) / SEC);

  // Iteratively size the FAT so it can map every data cluster.
  let fatSz = 1;
  for (;;) {
    const dataSectors = totalSectors - reserved - numFats * fatSz - rootDirSectors;
    const clusters = Math.floor(dataSectors / spc);
    const needed = Math.ceil(((clusters + 2) * 2) / SEC);
    if (needed <= fatSz) break;
    fatSz = needed;
  }
  const dataSectors = totalSectors - reserved - numFats * fatSz - rootDirSectors;
  const totalClusters = Math.floor(dataSectors / spc);
  if (totalClusters < 4085 || totalClusters > 65524) {
    throw new Error(`fatImage: cluster count ${totalClusters} outside FAT16 range — adjust volumeBytes`);
  }

  const img = new Uint8Array(totalSectors * SEC);

  // ── Boot sector / BPB (FAT16) ───────────────────────────────────────────
  img[0] = 0xeb;
  img[1] = 0x3c;
  img[2] = 0x90;
  writeAscii(img, 3, 'VELXIO  ', 8); // OEM name
  writeU16(img, 11, SEC); // bytes per sector
  img[13] = spc; // sectors per cluster
  writeU16(img, 14, reserved); // reserved sectors
  img[16] = numFats;
  writeU16(img, 17, rootEntries);
  writeU16(img, 19, totalSectors < 0x10000 ? totalSectors : 0); // total sectors (16)
  img[21] = 0xf8; // media descriptor (fixed disk)
  writeU16(img, 22, fatSz); // sectors per FAT
  writeU16(img, 24, 0x3f); // sectors per track
  writeU16(img, 26, 0xff); // num heads
  writeU32(img, 28, 0); // hidden sectors
  writeU32(img, 32, totalSectors < 0x10000 ? 0 : totalSectors); // total sectors (32)
  img[36] = 0x80; // drive number
  img[38] = 0x29; // extended boot signature
  writeU32(img, 39, 0x564c5849); // volume id ("VLXI")
  writeAscii(img, 43, (opts.label ?? 'VELXIO SD').toUpperCase(), 11);
  writeAscii(img, 54, 'FAT16   ', 8);
  img[510] = 0x55;
  img[511] = 0xaa;

  // ── FAT regions ─────────────────────────────────────────────────────────
  const fat1 = reserved * SEC;
  const fat2 = (reserved + fatSz) * SEC;
  const setFat = (cluster: number, value: number): void => {
    writeU16(img, fat1 + cluster * 2, value);
    writeU16(img, fat2 + cluster * 2, value);
  };
  setFat(0, 0xfff8); // media descriptor in entry 0
  setFat(1, 0xffff); // end-of-chain marker in entry 1

  const rootStart = (reserved + numFats * fatSz) * SEC;
  const dataStart = (reserved + numFats * fatSz + rootDirSectors) * SEC;
  const clusterBytes = spc * SEC;

  let nextCluster = 2;
  let rootSlot = 0;
  const used = new Set<string>(); // short-name uniqueness across files

  for (const f of files) {
    const short = shortNameFor(f.name, used);
    const need83 = !fitsShort(f.name);

    // Long-name (VFAT) entries, stored in reverse before the 8.3 entry.
    const lfnEntries: Uint8Array[] = [];
    if (need83) {
      const cksum = lfnChecksum(short);
      const chars = f.name + '\u0000'; // name + NUL terminator; rest padded 0xFFFF
      const count = Math.ceil(chars.length / 13);
      for (let seq = 1; seq <= count; seq++) {
        const e = new Uint8Array(32);
        e[0] = seq | (seq === count ? 0x40 : 0x00);
        e[11] = 0x0f; // LFN attribute
        e[13] = cksum;
        const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
        for (let k = 0; k < 13; k++) {
          const ci = (seq - 1) * 13 + k;
          const code = ci < chars.length ? chars.charCodeAt(ci) : 0xffff;
          e[slots[k]] = code & 0xff;
          e[slots[k] + 1] = (code >> 8) & 0xff;
        }
        lfnEntries.unshift(e); // reverse order
      }
    }

    // Allocate clusters and write data.
    const len = f.data.length;
    const fileClusters = Math.max(1, Math.ceil(len / clusterBytes));
    if (nextCluster + fileClusters - 1 > totalClusters + 1) {
      throw new Error(`fatImage: files exceed volume capacity (${volumeBytes} bytes)`);
    }
    const startCluster = nextCluster;
    for (let i = 0; i < fileClusters; i++) {
      const cl = nextCluster++;
      const at = dataStart + (cl - 2) * clusterBytes;
      img.set(f.data.subarray(i * clusterBytes, (i + 1) * clusterBytes), at);
      setFat(cl, i === fileClusters - 1 ? 0xffff : cl + 1);
    }

    // Root directory: LFN entries (if any) then the 8.3 entry.
    const entriesNeeded = lfnEntries.length + 1;
    if (rootSlot + entriesNeeded > rootEntries) {
      throw new Error('fatImage: too many files for the root directory (max 512 entries)');
    }
    for (const e of lfnEntries) {
      img.set(e, rootStart + rootSlot * 32);
      rootSlot++;
    }
    const d = rootStart + rootSlot * 32;
    rootSlot++;
    writeAscii(img, d, short, 11); // 8.3 name
    img[d + 11] = 0x20; // attr = archive
    writeU16(img, d + 26, startCluster); // first cluster (low word)
    writeU16(img, d + 20, 0); // first cluster (high word) — 0 for FAT16
    writeU32(img, d + 28, len); // file size
  }

  return img;
}
