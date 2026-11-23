// Recon: fetch key + first few segments, decrypt, dump TS facts.
import { writeFileSync, mkdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const dir = new URL('./out/', import.meta.url);
mkdirSync(dir, { recursive: true });

const base = 'https://p.jisuts.com:999/hls/956/20261107/4594271/';
const playlistUrl = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const plText = await (await fetch(playlistUrl)).text();
const lines = plText.split(/\r?\n/);
let segs = [];
let keyInfo = null;
let dur = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (l.startsWith('#EXT-X-KEY:')) keyInfo = l;
  if (l.startsWith('#EXTINF:')) {
    const d = parseFloat(l.slice(8));
    const uri = lines[i + 1].trim();
    segs.push({ d, uri });
    dur += d;
  }
}
console.log('segments', segs.length, 'totalDur', dur.toFixed(3), 'key:', keyInfo);
console.log('endlist', plText.includes('#EXT-X-ENDLIST'));
console.log('last lines:', lines.slice(-6));

const keyUrl = new URL('enc.key', playlistUrl).href;
const keyBuf = new Uint8Array(await (await fetch(keyUrl)).arrayBuffer());
console.log('keyUrl', keyUrl, 'keyLen', keyBuf.length, Buffer.from(keyBuf).toString('hex'));
writeFileSync(new URL('enc.key', dir), keyBuf);

const cryptoKey = await webcrypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
const iv = new Uint8Array(16);

for (let idx = 0; idx < 4; idx++) {
  const url = new URL(segs[idx].uri, playlistUrl).href;
  const t0 = Date.now();
  const r = await fetch(url);
  const enc = new Uint8Array(await r.arrayBuffer());
  const t1 = Date.now();
  let dec;
  try {
    dec = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, enc));
  } catch (e) {
    console.log('decrypt fail', idx, e.message, 'encLen', enc.length);
    continue;
  }
  console.log(`seg${idx} dur=${segs[idx].d} encLen=${enc.length} decLen=${dec.length} sync=${dec[0].toString(16)} fetchMs=${t1 - t0}`);
  writeFileSync(new URL(`seg${idx}.ts`, dir), dec);
  // scan PAT/PMT pids + first PES headers
  const pids = new Map();
  for (let o = 0; o + 188 <= dec.length; o += 188) {
    if (dec[o] !== 0x47) { console.log('bad sync at', o); break; }
    const pid = ((dec[o + 1] & 0x1f) << 8) | dec[o + 2];
    pids.set(pid, (pids.get(pid) || 0) + 1);
  }
  console.log('  pids', [...pids.entries()].map(([p, c]) => `0x${p.toString(16)}:${c}`).join(' '));
  // first PES header per pid
  const seen = new Set();
  for (let o = 0; o + 188 <= dec.length; o += 188) {
    const pid = ((dec[o + 1] & 0x1f) << 8) | dec[o + 2];
    if (seen.has(pid)) continue;
    const pusi = (dec[o + 1] & 0x40) !== 0;
    if (!pusi) continue;
    const afc = (dec[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc === 2 || afc === 3) p += 1 + dec[p];
    if (dec[p] === 0 && dec[p + 1] === 0 && dec[p + 2] === 1) {
      const sid = dec[p + 3];
      if (sid === 0xba) { seen.add(pid); continue; }
      const pesLen = (dec[p + 4] << 8) | dec[p + 5];
      const flags = dec[p + 7];
      const hdrLen = dec[p + 8];
      let pts = -1, dts = -1;
      if (flags & 0x80) {
        const q = p + 9;
        pts = ((dec[q] >> 1) & 7) * 2 ** 30 + ((dec[q + 1] << 22) >>> 0) + (((dec[q + 2] >> 1) & 0x7f) << 15) + (dec[q + 3] << 7) + (dec[q + 4] >> 1);
        if (flags & 0x40) {
          dts = ((dec[q + 5] >> 1) & 7) * 2 ** 30 + ((dec[q + 6] << 22) >>> 0) + (((dec[q + 7] >> 1) & 0x7f) << 15) + (dec[q + 8] << 7) + (dec[q + 9] >> 1);
        }
      }
      console.log(`  first PES pid=0x${pid.toString(16)} sid=0x${sid.toString(16)} pesLen=${pesLen} flags=0x${flags.toString(16)} hdrLen=${hdrLen} pts=${pts} dts=${dts} ptsSec=${pts >= 0 ? (pts / 90000).toFixed(3) : '-'}`);
      seen.add(pid);
    }
  }
}
