#!/usr/bin/env node
// Lists and extracts zip archives with Node built-ins only. tool-wrapper.sh
// falls back to it when neither unzip nor bsdtar is installed.
//
//   node unzip.cjs list <zip>           one entry name per line
//   node unzip.cjs extract <zip> <dir>  extract into <dir>
//
// It validates every entry before it writes anything, and refuses absolute
// paths, drive letters, backslashes, ".." segments and symlinks that leave the
// target. Entries are extracted into a staging directory and moved into place
// only when all of them passed their CRC check.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

class ZipError extends Error {}

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new ZipError('not a zip archive: no end of central directory');
}

function isMacMeta(name) {
  return name === '__MACOSX/' || name.startsWith('__MACOSX/');
}

function listEntries(buf) {
  if (buf.length < 22) throw new ZipError('not a zip archive: too short');
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('refused: ZIP64 is not supported');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('not a zip archive: bad central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ZipError('refused: ZIP64 is not supported');
    }
    if (isMacMeta(name)) continue;
    const mode = attrs >>> 16;
    const type = mode & S_IFMT;
    entries.push({
      name, method, crc, compressedSize, size, offset, mode,
      isDir: name.endsWith('/') || type === S_IFDIR,
      isSymlink: type === S_IFLNK,
      encrypted: (flags & 1) === 1,
    });
  }
  return entries;
}

function entryData(buf, e) {
  if (buf.readUInt32LE(e.offset) !== LOCAL) throw new ZipError(`not a zip archive: bad local header for ${e.name}`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const body = buf.subarray(start, start + e.compressedSize);
  let data;
  if (e.method === 0) data = body;
  else if (e.method === 8) data = zlib.inflateRawSync(body);
  else throw new ZipError(`refused: ${e.name} uses compression method ${e.method}`);
  if (data.length !== e.size || crc32(data) !== e.crc) throw new ZipError(`CRC mismatch: ${e.name}`);
  return data;
}

function checkName(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`refused: unsafe entry name ${JSON.stringify(name)}`);
  }
  if (name.split('/').some((part) => part === '..')) {
    throw new ZipError(`refused: entry name leaves the target: ${JSON.stringify(name)}`);
  }
}

// Validates all entries and reads their data before anything is written.
function plan(buf) {
  const entries = listEntries(buf);
  const root = path.resolve('/zip-root');
  const items = [];
  for (const e of entries) {
    checkName(e.name);
    if (e.encrypted) throw new ZipError(`refused: ${e.name} is encrypted`);
    if (e.isDir) {
      items.push({ ...e, data: null });
      continue;
    }
    const data = entryData(buf, e);
    if (e.isSymlink) {
      const target = data.toString('utf8');
      const resolved = path.resolve(path.dirname(path.join(root, e.name)), target);
      if (path.isAbsolute(target) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
        throw new ZipError(`refused: symlink ${e.name} points outside the target`);
      }
    }
    items.push({ ...e, data });
  }
  return items;
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * Where `dir` really is, through the links an earlier entry wrote: the real
 * path of its deepest existing ancestor joined with the rest. The rest is made
 * of plain names, which checkName holds to.
 */
function realDir(dir) {
  let existing = dir;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.join(fs.realpathSync(existing), path.relative(existing, dir));
}

function extract(zipPath, dir) {
  const items = plan(fs.readFileSync(zipPath));
  const target = path.resolve(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = `${target}.partial-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const stageReal = fs.realpathSync(stage);
  try {
    for (const it of items) {
      const dest = path.join(stage, it.name);
      // plan() judged each link by the names in the archive. A link written
      // earlier can make the real place differ, as with `a/l1 -> ..` then
      // `a/l1/l2 -> ..`, so each entry is checked where it really lands.
      const parent = realDir(it.isDir ? dest : path.dirname(dest));
      if (!inside(stageReal, parent)) throw new ZipError(`refused: ${it.name} leaves the target through a symlink`);
      if (it.isSymlink && !inside(stageReal, path.resolve(parent, it.data.toString('utf8')))) {
        throw new ZipError(`refused: symlink ${it.name} points outside the target`);
      }
      if (it.isDir) {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (it.isSymlink && process.platform !== 'win32') {
        fs.symlinkSync(it.data.toString('utf8'), dest);
        continue;
      }
      fs.writeFileSync(dest, it.data);
      const perm = it.mode & 0o777;
      if (perm && process.platform !== 'win32') fs.chmodSync(dest, perm);
    }
    if (!fs.existsSync(target)) {
      fs.renameSync(stage, target);
    } else {
      for (const name of fs.readdirSync(stage)) {
        const from = path.join(stage, name);
        const to = path.join(target, name);
        fs.rmSync(to, { recursive: true, force: true });
        fs.renameSync(from, to);
      }
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

function main(argv) {
  const [cmd, zip, dir] = argv;
  try {
    if (cmd === 'list' && zip) {
      for (const e of listEntries(fs.readFileSync(zip))) process.stdout.write(`${e.name}\n`);
      return 0;
    }
    if (cmd === 'extract' && zip && dir) {
      extract(zip, dir);
      return 0;
    }
    process.stderr.write('usage: unzip.cjs list <zip> | extract <zip> <dir>\n');
    return 2;
  } catch (err) {
    process.stderr.write(`unzip.cjs: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { listEntries, extract, ZipError };
