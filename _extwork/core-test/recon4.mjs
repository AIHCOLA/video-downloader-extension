// Recon4: proper first-PES + all video PES stats across selected segments.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const dir = new URL('./out/', import.meta.url);
mkdirSync(dir, { recursive: true });
const playlistUrl = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const plText = await (await fetch(playlistUrl)).text();
const L = plText.split(/\r?\n/);
const segs = []; let acc = 0;
for (let i = 0; i < L.length; i++) {
  const l = L[i].trim();
  if (l.startsWith('#EXTINF:')) { const d = parseFloat(l.slice(8)); segs.push({ d, start: acc, uri: L[i + 1].trim() }); acc += d; }
}
const keyUrl = new URL('enc.key', playlistUrl).href;
const keyBuf = new Uint8Array(await (await fetch(keyUrl)).arrayBuffer());
const cryptoKey = await webcrypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
const iv = new Uint8Array(16);
async function getSeg(u, c) { const f = new URL(c, dir); if (existsSync(f)) return readFileSync(f); const enc = new Uint8Array(await (await fetch(u)).arrayBuffer()); const dec = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, enc)); writeFileSync(f, dec); return dec; }
function parsePtsB(b) { return ((b[0] >> 1) & 7) * 1073741824 + (b[1] << 22) + (((b[2] >> 1) & 0x7f) << 15) + (b[3] << 7) + (b[4] >> 1); }
function cutNals(pl) { const out = []; for (let q = 0; q + 4 < pl.length; q++) { if (pl[q] === 0 && pl[q + 1] === 0 && pl[q + 2] === 1) { const t = pl[q + 3] & 0x1f; let e = pl.length; for (let r = q + 4; r + 3 < pl.length; r++) if (pl[r] === 0 && pl[r + 1] === 0 && pl[r + 2] === 1) { e = r; break; } out.push({ t, len: e - q }); q = e - 1; } } return out; }

function demux(ts) {
  let pmt = -1, vpid = -1, apid = -1;
  const pesBuf = new Map();
  const vAll = [], aAll = [];
  const firsts = new Map();
  const flush = (pid) => {
    const r = pesBuf.get(pid); pesBuf.delete(pid);
    if (!r || r.length < 9) return;
    const b = r.bytes.subarray(0, r.length);
    const flags = b[7]; const hdrLen = b[8];
    let pts = null, dts = null;
    if (flags & 0x80) pts = parsePtsB(b.subarray(9, 14));
    if (flags & 0x40) dts = parsePtsB(b.subarray(14, 19));
    const payload = b.subarray(9 + hdrLen);
    const rec = { pts, dts, payload, sid: b[3] };
    if (!firsts.has(pid)) firsts.set(pid, rec);
    (pid === vpid ? vAll : aAll).push(rec);
  };
  for (let o = 0; o + 188 <= ts.length; o += 188) {
    if (ts[o] !== 0x47) continue;
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    const pusi = (ts[o + 1] & 0x40) !== 0;
    const afc = (ts[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc === 2 || afc === 3) p += 1 + ts[p];
    if (afc === 0 || afc === 2) continue;
    const payload = ts.subarray(p, o + 188);
    if (pid === 0 && pusi) { const ptr = payload[0]; const sec = payload.subarray(1 + ptr); for (let q = 8; q + 4 <= 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4; q += 4) { const prog = (sec[q] << 8) | sec[q + 1]; const pp = ((sec[q + 2] & 0x1f) << 8) | sec[q + 3]; if (prog !== 0) pmt = pp; } }
    else if (pid === pmt && pusi) { const ptr = payload[0]; const sec = payload.subarray(1 + ptr); const pil = ((sec[10] & 0x0f) << 8) | sec[11]; let q = 12 + pil; const end = 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4; while (q + 5 <= end) { const st = sec[q]; const ep = ((sec[q + 1] & 0x1f) << 8) | sec[q + 2]; const el = ((sec[q + 3] & 0x0f) << 8) | sec[q + 4]; if (st === 0x1b) vpid = ep; else if (st === 0x0f) apid = ep; q += 5 + el; } }
    if (pid !== vpid && pid !== apid) continue;
    if (pusi) { if (pesBuf.has(pid)) flush(pid); pesBuf.set(pid, { bytes: new Uint8Array(payload), length: payload.length }); }
    else if (pesBuf.has(pid)) { const r = pesBuf.get(pid); const nb = new Uint8Array(r.length + payload.length); nb.set(r.bytes.subarray(0, r.length)); nb.set(payload, r.length); r.bytes = nb; r.length = nb.length; }
  }
  for (const pid of [...pesBuf.keys()]) flush(pid);
  return { vpid, apid, vAll, aAll, firsts };
}

const segIdx = process.argv.slice(2).map(Number);
for (const idx of (segIdx.length ? segIdx : [0, 1, 2, 3, 8, 15, 16, 17, 18])) {
  const s = segs[idx];
  const buf = await getSeg(new URL(s.uri, playlistUrl).href, `seg${idx}.ts`);
  const { vpid, apid, vAll, aAll, firsts } = demux(buf);
  const v = firsts.get(vpid), a = firsts.get(apid);
  const nals = cutNals(v.payload);
  const offsetSec = (v.pts - s.start * 90000) / 90000;
  // cto stats
  const ctos = new Map(); let neg = 0;
  const vframes = vAll.map(p => {
    const dts = p.dts ?? p.pts; const cto = p.pts - dts; ctos.set(cto, (ctos.get(cto) || 0) + 1); if (cto < 0) neg++;
    return { pts: p.pts, dts, cto, nals: cutNals(p.payload) };
  });
  const idrs = vframes.filter(f => f.nals.some(n => n.t === 5)).length;
  // audio pts step
  const aPts = aAll.map(p => p.pts);
  let steps = new Set(); for (let i = 1; i < aPts.length; i++) steps.add(aPts[i] - aPts[i - 1]);
  console.log(`seg${idx} cum=${s.start.toFixed(3)} d=${s.d} | vFirstPts=${v.pts} (${(v.pts / 90000).toFixed(3)}) off=${offsetSec.toFixed(4)}s nals=[${nals.map(n => n.t).join(',')}] vPES=${vAll.length} idrPES=${idrs} negCto=${neg} cto=${[...ctos.entries()].sort((a, b) => a[0] - b[0]).map(x => x[0] + ':' + x[1]).join(',')} | aFirstPts=${a.pts} aPES=${aAll.length} aSteps=${[...steps].slice(0, 5)}`);
}
