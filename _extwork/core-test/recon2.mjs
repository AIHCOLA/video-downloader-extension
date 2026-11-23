// Recon2: demux TS packets -> PES for video/audio, inspect AU structure, keyframes, cto, ADTS.
import { readFileSync } from 'node:fs';

const dir = new URL('./out/', import.meta.url);
const segCount = 4;
const PTS_MASK = 1n << 33n;

function readPts(d, p) {
  const b1 = d[p], b2 = d[p + 1], b3 = d[p + 2], b4 = d[p + 3], b5 = d[p + 4];
  const v = ((b1 >> 1) & 7) * 2 ** 30 + ((b2 << 22) | (b3 >> 6 << 14) >> 6) * 0; // placeholder
  return 0;
}
function ts2sec(pts) { return pts / 90000; }
function parsePtsBytes(b) {
  return ((b[0] >> 1) & 7) * 1073741824 + (b[1] << 22) + (((b[2] >> 1) & 0x7f) << 15) + (b[3] << 7) + (b[4] >> 1);
}

const state = {
  pmtPid: -1, videoPid: -1, audioPid: -1,
  pesBuf: new Map(), // pid -> {bufs:[], len, started}
  videoPES: [], audioPES: [],
};

function demuxTs(ts) {
  const out = [];
  for (let o = 0; o + 188 <= ts.length; o += 188) {
    if (ts[o] !== 0x47) { continue; }
    const tei = (ts[o + 1] & 0x80) !== 0;
    if (tei) continue;
    const pusi = (ts[o + 1] & 0x40) !== 0;
    const pid = ((ts[o + 1] & 0x1f) << 8) | ts[o + 2];
    const afc = (ts[o + 3] >> 4) & 3;
    let p = o + 4;
    let payloadStart = p;
    if (afc === 2 || afc === 3) {
      const afLen = ts[p];
      p += 1 + afLen;
    }
    if (afc === 0 || afc === 2) continue; // no payload
    payloadStart = p;
    const payload = ts.subarray(payloadStart, o + 188);
    if (pid === 0) {
      // PAT
      if (pusi) {
        const ptr = payload[0]; const sec = payload.subarray(1 + ptr);
        const sectionEnd = 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4;
        for (let q = 8; q + 4 <= sectionEnd; q += 4) {
          const prog = (sec[q] << 8) | sec[q + 1];
          const pmtPid = ((sec[q + 2] & 0x1f) << 8) | sec[q + 3];
          if (prog !== 0) state.pmtPid = pmtPid;
        }
      }
      continue;
    }
    if (pid === state.pmtPid) {
      if (pusi) {
        const ptr = payload[0]; const sec = payload.subarray(1 + ptr);
        const sectionLen = ((sec[1] & 0x0f) << 8) | sec[2];
        const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
        let q = 12 + progInfoLen;
        const end = 3 + sectionLen - 4;
        while (q + 5 <= end) {
          const st = sec[q];
          const epid = ((sec[q + 1] & 0x1f) << 8) | sec[q + 2];
          const esLen = ((sec[q + 3] & 0x0f) << 8) | sec[q + 4];
          if (st === 0x1b) state.videoPid = epid;
          else if (st === 0x0f) state.audioPid = epid;
          q += 5 + esLen;
        }
      }
      continue;
    }
    if (pid !== state.videoPid && pid !== state.audioPid) continue;
    if (pusi) {
      // flush previous for this pid
      if (state.pesBuf.has(pid)) {
        const prev = state.pesBuf.get(pid);
        state.pesBuf.delete(pid);
        if (prev.bytes.length >= 9) {
          const rec = parsePES(prev.bytes, pid);
          if (rec) (pid === state.videoPid ? state.videoPES : state.audioPES).push(rec);
        }
      }
      state.pesBuf.set(pid, { bytes: new Uint8Array(payload.length), length: 0 });
      const rec = state.pesBuf.get(pid);
      rec.bytes.set(payload); rec.length = payload.length;
    } else {
      const rec = state.pesBuf.get(pid);
      if (!rec) continue;
      const newBytes = new Uint8Array(rec.length + payload.length);
      newBytes.set(rec.bytes.subarray(0, rec.length));
      newBytes.set(payload, rec.length);
      rec.bytes = newBytes; rec.length = newBytes.length;
    }
  }
}

const videoBins = new Map();
function parsePES(bytes, pid) {
  if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1) return null;
  const sid = bytes[3];
  const pesLen = (bytes[4] << 8) | bytes[5];
  const flags = bytes[7];
  const hdrLen = bytes[8];
  const payload = bytes.subarray(9 + hdrLen);
  let pts = null, dts = null;
  if (flags & 0x80) pts = parsePtsBytes(bytes.subarray(9, 14));
  if (flags & 0x40) dts = parsePtsBytes(bytes.subarray(14, 19));
  return { pid, sid, pesLen, pts, dts, payload, declaredLen: bytes.length };
}

// iterate segments
let allV = [], allA = [];
for (let i = 0; i < segCount; i++) {
  const ts = readFileSync(new URL(`seg${i}.ts`, dir));
  demuxTs(ts);
}
// flush remaining
for (const [pid, rec] of state.pesBuf) {
  if (rec.length >= 9) {
    const r = parsePES(rec.bytes.subarray(0, rec.length), pid);
    if (r) (pid === state.videoPid ? state.videoPES : state.audioPES).push(r);
  }
}
state.pesBuf.clear();

console.log('PIDs pat=%d pmt=0x%x video=0x%x audio=0x%x', 0x00, state.pmtPid, state.videoPid, state.audioPid);
console.log('video PES', state.videoPES.length, 'audio PES', state.audioPES.length);

// --- video AU analysis: NAL types per PES
const nalTypeCounts = new Map();
let audCount = 0, multiNalPes = 0, pesWithoutAUD = 0, pesWithSlice = 0;
const keyPts = [];
const vFrames = [];
for (const p of state.videoPES) {
  const pl = p.payload;
  const nals = [];
  for (let q = 0; q + 4 < pl.length; q++) {
    if (pl[q] === 0 && pl[q + 1] === 0 && pl[q + 2] === 1) {
      const t = pl[q + 3] & 0x1f;
      nals.push(t);
      nalTypeCounts.set(t, (nalTypeCounts.get(t) || 0) + 1);
      let end = pl.length;
      for (let r = q + 4; r + 3 < pl.length; r++) if (pl[r] === 0 && pl[r + 1] === 0 && pl[r + 2] === 1) { end = r; break; }
      nals[nals.length - 1] = { type: t, start: q, end };
      q = end - 1;
    }
  }
  if (nals.length) {
    if (nals.some(x => x.type === 9)) audCount++;
    if (nals.length > 2) multiNalPes++;
    if (!nals.some(x => x.type === 9)) pesWithoutAUD++;
    const idr = nals.some(x => typeof x === 'object' ? x.type === 5 : x === 5);
    if (idr) keyPts.push({ pts: p.pts, dts: p.dts, sec: p.pts == null ? null : ts2sec(p.pts) });
    if (nals.some(x => typeof x === 'object' ? (x.type === 1 || x.type === 5) : (x === 1 || x === 5))) pesWithSlice++;
    vFrames.push({ pts: p.pts, dts: p.dts, nals: nals.map(x => x.type ?? x), idr, len: pl.length });
  }
}
console.log('video: nalTypeCounts=', [...nalTypeCounts.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => t + ':' + c).join(' '));
console.log('video: pesWithAUD=%d withoutAUD=%d multiNalPes=%d pesWithSlice=%d', audCount, pesWithoutAUD, multiNalPes, pesWithSlice);
console.log('video: frames=%d keyframes=%d', vFrames.length, keyPts.length);
console.log('keyframes:', JSON.stringify(keyPts.slice(0, 20)));
// cto distribution
const ctos = new Map();
for (const f of vFrames) {
  if (f.dts == null) continue;
  const cto = f.pts - f.dts;
  ctos.set(cto, (ctos.get(cto) || 0) + 1);
}
console.log('cto (pts-dts, 90kHz) distribution:', [...ctos.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => k + ':' + v).join(' '));
console.log('first 12 vFrames:', JSON.stringify(vFrames.slice(0, 12)));
// detect PES payload with multiple AUs: count nals type1/5 per PES
const sliceCounts = new Map();
for (const p of state.videoPES) {
  const pl = p.payload;
  let slices = 0, auds = 0;
  for (let q = 0; q + 4 < pl.length; q++) {
    if (pl[q] === 0 && pl[q + 1] === 0 && pl[q + 2] === 1) {
      const t = pl[q + 3] & 0x1f;
      if (t === 1 || t === 5) slices++;
      if (t === 9) auds++;
      let end = pl.length;
      for (let r = q + 4; r + 3 < pl.length; r++) if (pl[r] === 0 && pl[r + 1] === 0 && pl[r + 2] === 1) { end = r; break; }
      q = end - 1;
    }
  }
  const k = slices + 'slices/' + auds + 'aud';
  sliceCounts.set(k, (sliceCounts.get(k) || 0) + 1);
}
console.log('per-PES slice/aud counts:', [...sliceCounts.entries()].map(([k, v]) => k + '=' + v).join(' '));

// --- audio ADTS
console.log('audio PES first:', state.audioPES.slice(0, 3).map(p => ({ pts: p.pts, len: p.payload.length })));
let adtsFrames = 0, samplRates = new Set(), channels = new Set(), badHdr = 0;
for (const p of state.audioPES) {
  const pl = p.payload;
  let q = 0;
  while (q + 7 <= pl.length) {
    if (pl[q] === 0xff && (pl[q + 1] & 0xf0) === 0xf0) {
      const profile = (pl[q + 2] >> 6) & 3;
      const sf = (pl[q + 2] >> 2) & 0xf;
      const ch = ((pl[q + 2] & 1) << 2) | ((pl[q + 3] >> 6) & 3);
      const frameLen = ((pl[q + 3] & 3) << 11) | (pl[q + 4] << 3) | ((pl[q + 5] >> 5) & 7);
      const hdrLen = (pl[q + 1] & 1) ? 7 : 9;
      if (frameLen <= 0) { badHdr++; break; }
      samplRates.add(sf); channels.add(ch); adtsFrames++;
      q += frameLen;
    } else { badHdr++; break; }
  }
}
console.log('audio ADTS frames=%d bad=%d sfIdx=%s channels=%s', adtsFrames, badHdr, [...samplRates], [...channels]);
