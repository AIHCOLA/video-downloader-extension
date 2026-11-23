// Recon3: inspect segments 15..18 for keyframe alignment, PTS offset, cto signs, audio pts deltas.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const dir = new URL('./out/', import.meta.url);
mkdirSync(dir, { recursive: true });

const playlistUrl = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const plText = await (await fetch(playlistUrl)).text();
const L = plText.split(/\r?\n/);
const segs = [];
let acc = 0;
for (let i = 0; i < L.length; i++) {
  const l = L[i].trim();
  if (l.startsWith('#EXTINF:')) {
    const d = parseFloat(l.slice(8));
    segs.push({ d, start: acc, uri: L[i + 1].trim() });
    acc += d;
  }
}
const keyUrl = new URL('enc.key', playlistUrl).href;
const keyBuf = new Uint8Array(await (await fetch(keyUrl)).arrayBuffer());
const cryptoKey = await webcrypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
const iv = new Uint8Array(16);

async function getSeg(encUrl, cacheName) {
  const f = new URL(cacheName, dir);
  if (existsSync(f)) return readFileSync(f);
  const enc = new Uint8Array(await (await fetch(encUrl)).arrayBuffer());
  const dec = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, enc));
  writeFileSync(f, dec);
  return dec;
}

function parsePtsB(b) { return ((b[0] >> 1) & 7) * 1073741824 + (b[1] << 22) + (((b[2] >> 1) & 0x7f) << 15) + (b[3] << 7) + (b[4] >> 1); }

function pollSeg(ts, perPidFirst) {
  // returns map pid -> first PES meta
  const out = new Map();
  const pesBuf = new Map();
  const flush = (pid) => {
    const r = pesBuf.get(pid); pesBuf.delete(pid);
    if (!r || r.length < 9) return;
    const b = r.bytes.subarray(0, r.length);
    const flags = b[7]; const hdrLen = b[8];
    let pts = null, dts = null;
    if (flags & 0x80) pts = parsePtsB(b.subarray(9, 14));
    if (flags & 0x40) dts = parsePtsB(b.subarray(14, 19));
    out.set(pid, { pts, dts, payload: b.subarray(9 + hdrLen), sid: b[3], nals: !!r.firstAud });
  };
  // PAT/PMT quick
  let pmt = -1, vpid = -1, apid = -1;
  for (let o = 0; o + 188 <= ts.length; o += 188) {
    if (ts[o] !== 0x47) continue;
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    const pusi = (ts[o + 1] & 0x40) !== 0;
    const afc = (ts[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc === 2 || afc === 3) p += 1 + ts[p];
    if (afc === 0 || afc === 2) continue;
    const payload = ts.subarray(p, o + 188);
    if (pid === 0 && pusi) {
      const ptr = payload[0]; const sec = payload.subarray(1 + ptr);
      for (let q = 8; q + 4 <= 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4; q += 4) {
        const prog = (sec[q] << 8) | sec[q + 1]; const pp = ((sec[q + 2] & 0x1f) << 8) | sec[q + 3];
        if (prog !== 0) pmt = pp;
      }
    } else if (pid === pmt && pusi) {
      const ptr = payload[0]; const sec = payload.subarray(1 + ptr);
      const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
      let q = 12 + progInfoLen; const end = 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4;
      while (q + 5 <= end) { const st = sec[q]; const ep = ((sec[q + 1] & 0x1f) << 8) | sec[q + 2]; const el = ((sec[q + 3] & 0x0f) << 8) | sec[q + 4]; if (st === 0x1b) vpid = ep; else if (st === 0x0f) apid = ep; q += 5 + el; }
    }
    if (pid !== vpid && pid !== apid) continue;
    if (pusi) {
      if (pesBuf.has(pid)) flush(pid);
      pesBuf.set(pid, { bytes: new Uint8Array(payload), length: payload.length });
    } else if (pesBuf.has(pid)) {
      const r = pesBuf.get(pid);
      const nb = new Uint8Array(r.length + payload.length);
      nb.set(r.bytes.subarray(0, r.length)); nb.set(payload, r.length);
      r.bytes = nb; r.length = nb.length;
    }
  }
  for (const pid of [...pesBuf.keys()]) flush(pid);
  return { out, vpid, apid, pmt };
}

let globalMinCto = Infinity, globalMaxCto = -Infinity, ctoNeg = 0, framesChecked = 0;
const audioPtsSeq = [];
for (const idx of [15, 16, 17, 18, 0]) {
  const s = segs[idx];
  const buf = await getSeg(new URL(s.uri, playlistUrl).href, `seg${idx}.ts`);
  const { out, vpid, apid } = pollSeg(buf);
  const v = out.get(vpid), a = out.get(apid);
  const off = v.pts - s.start * 90000;
  console.log(`seg${idx} cumStart=${s.start.toFixed(3)} d=${s.d} video: pts=${v.pts} (${(v.pts / 90000).toFixed(3)}s) dts=${v.dts} ptsOffsetVsCum=${(off / 90000).toFixed(3)}s; audio pts=${a.pts} (${(a.pts / 90000).toFixed(3)}s)`);
  // IDR check in payload
  const pl = v.payload;
  const nals = [];
  for (let q = 0; q + 4 < pl.length; q++) if (pl[q] === 0 && pl[q + 1] === 0 && pl[q + 2] === 1) { nals.push(pl[q + 3] & 0x1f); let e = pl.length; for (let r = q + 4; r + 3 < pl.length; r++) if (pl[r] === 0 && pl[r + 1] === 0 && pl[r + 2] === 1) { e = r; break; } q = e - 1; }
  console.log('   first PES nals:', nals.join(','), 'payloadLen', pl.length);
}
