// Benchmark concurrent segment downloads.
const playlistUrl = 'https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8';
const t0 = Date.now();
const plText = await (await fetch(playlistUrl)).text();
const L = plText.split(/\r?\n/);
const segs = []; let acc = 0;
for (let i = 0; i < L.length; i++) {
  const l = L[i].trim();
  if (l.startsWith('#EXTINF:')) { const d = parseFloat(l.slice(8)); segs.push({ d, start: acc, uri: L[i + 1].trim() }); acc += d; }
}
console.log('playlist ms', Date.now() - t0, 'segs', segs.length);
const keyUrl = new URL('enc.key', playlistUrl).href;
console.log('key', await (await fetch(keyUrl)).text(), 'keyMs', Date.now() - t0);

async function bench(n, conc) {
  const urls = segs.slice(n, n + conc).map(s => new URL(s.uri, playlistUrl).href);
  const st = Date.now();
  const t1 = Date.now();
  const res = await Promise.all(urls.map(async (u) => {
    const s = Date.now();
    const r = await fetch(u);
    const b = await r.arrayBuffer();
    return { ms: Date.now() - s, bytes: b.byteLength };
  }));
  const total = res.reduce((a, x) => a + x.bytes, 0);
  const elapsed = (Date.now() - st) / 1000;
  console.log(`conc=${conc} firstSeg=${n} fetchAllMs=${Date.now() - st} bytes=${total} MB/s=${(total / 1e6 / elapsed).toFixed(2)} perMs=${res.map(r => r.ms).join(',')}`);
}
await bench(0, 1);
await bench(10, 8);
await bench(40, 16);
await bench(100, 16);
