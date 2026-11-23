// Smoke: 60-70 MP4 clip. mode=progressive (supportsPosition) | fragmented (legacy sequential).
import { writeFileSync, mkdirSync } from 'node:fs';
import { probePlaylist, downloadHls } from '../../浏览器扩展/src/core/index.mjs';

const outDir = new URL('./out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const url = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const mode = process.argv[2] || 'progressive';

let file = new Uint8Array(0);
const seqParts = [];
const writePosition = (chunk, position) => {
  const start = position === undefined ? file.length : position;
  const end = start + chunk.length;
  if (end > file.length) {
    const next = new Uint8Array(end);
    next.set(file);
    file = next;
  }
  file.set(chunk, start);
};
const writeSequential = (chunk) => { seqParts.push(chunk.slice()); };

const info = await probePlaylist(url, {});
console.log('PROBE', JSON.stringify({ segments: info.segments, duration: info.durationSeconds, encrypted: info.encrypted }));

const t1 = Date.now();
const result = await downloadHls({
  playlistUrl: url,
  start: 60,
  end: mode === 'fragmented' ? 100 : 70,
  concurrency: 16,
  onLog: (l, m) => console.log(`[dl ${l}] ${m}`),
  output: {
    type: 'mp4',
    supportsPosition: mode === 'progressive',
    write: mode === 'progressive' ? writePosition : writeSequential,
  },
});
console.log('RESULT', JSON.stringify(result), 'elapsed', Date.now() - t1);

if (mode !== 'progressive') {
  const total = seqParts.reduce((a, p) => a + p.length, 0);
  file = new Uint8Array(total);
  let off = 0;
  for (const p of seqParts) { file.set(p, off); off += p.length; }
}
const target = new URL(`clip-${mode}.mp4`, outDir);
writeFileSync(target, file);
const text = Buffer.from(file).toString('latin1');
console.log('WROTE', target.pathname, 'bytes', file.length, 'moovIdx', text.indexOf('moov'), 'mdatIdx', text.indexOf('mdat'));
