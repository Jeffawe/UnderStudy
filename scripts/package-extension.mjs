#!/usr/bin/env node
/**
 * Package the extension for the browser stores.
 *
 *   npm run extension:package
 *
 * Writes, under build/extension/:
 *   chrome/  + understudy-chrome.zip    Chrome Web Store and Edge Add-ons (same zip)
 *   firefox/ + understudy-firefox.zip   Firefox Add-ons
 *
 * The folders are what a browser loads for testing; the zips are what you upload.
 *
 * Firefox differs in two ways: it doesn't run extension service workers, so
 * background.js loads as a background script; and it needs an add-on id.
 * Everything else — the code, the chrome.* calls — is the same.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const SRC = 'extension';
const OUT = 'build/extension';
const FIREFOX_ID = 'understudy-recorder@jeffawe';

/** Files that ship to a store (the README is for people loading it by hand). */
const shipped = (file) => !file.endsWith('README.md');

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
const builds = {
  chrome: manifest,
  firefox: {
    ...manifest,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ID,
        // 140 is the first Firefox that knows data_collection_permissions (and an ESR).
        strict_min_version: '140.0',
        // Firefox asks every add-on to declare what it collects: nothing leaves
        // the machine (the extension talks only to understudy on 127.0.0.1).
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    },
  },
};

const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

// --- a minimal zip writer: deflate each file, then the central directory ----
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

rmSync(OUT, { recursive: true, force: true });
for (const [browser, m] of Object.entries(builds)) {
  const dir = join(OUT, browser);
  mkdirSync(dir, { recursive: true });
  cpSync(SRC, dir, { recursive: true, filter: (p) => statSync(p).isDirectory() || shipped(p) });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const entries = files(dir).sort().map((path) => ({ name: relative(dir, path).split('\\').join('/'), data: readFileSync(path) }));
  const out = join(OUT, `understudy-${browser}.zip`);
  writeFileSync(out, zip(entries));
  console.log(`${out}  (${entries.length} files, ${(statSync(out).size / 1024).toFixed(1)} KB)`);
}
