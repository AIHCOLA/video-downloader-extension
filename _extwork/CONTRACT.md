# 浏览器扩展（Chrome/Edge MV3）开发约定 — Lead 制定，core 与 shell 两位成员必须共同遵守

工作区：`C:\Users\20823\Documents\deepseek-harness\default-workspace`
交付目录：`浏览器扩展/`（最终会被 zip 打包给用户，只允许出现运行所需文件）
开发目录：`_extwork/`（测试脚本、临时产物、node_modules，不打包）

---

## 0. 已经由 Lead 完成 / 已确认的事实（直接采信，不要重复验证环境）

- 目标流：`https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8`
  - 媒体播放列表，**1309 个片段，总时长 4988.7 秒（01:23:09）**，`#EXT-X-ENDLIST` 存在（VOD）。
  - `#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x0000...0000`（16 字节全零 IV，显式给出）。
  - 分片：`https://p.jisuts.com:999/hls/956/20261107/4594271/plistN.ts`，每片约 5.4 秒。
  - 视频：H.264 High，1920x1080，24fps；音频：AAC-LC 48kHz 立体声（ffprobe 结论）。
  - **实测无需 Referer、无需特殊 UA、无需 Cookie**；Node fetch / Chrome fetch 均可直接访问（该站点 CORS 不限制扩展页面 + host_permissions）。
  - 已完成参考产物（用于对比校验）：`downloads/video_aQWNV05d.mp4`（1431632355 字节，01:23:08.69，119728 帧）。
- 环境：Node **v20.19.0**（`node` 在 PATH），npm 可用但**必须设置** `npm_config_cache` 到工作区内（默认 cache 在用户目录会被沙箱拒绝）：
  `$env:npm_config_cache='C:\Users\20823\Documents\deepseek-harness\default-workspace\_extwork\npm-cache'`
- ffmpeg（用于校验，不是扩展依赖）：`_tools\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe`（ffprobe 没有单独提供，用 `ffmpeg -i` 看信息即可）。
- 本机 Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`（156.0.8078.80）；Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
- puppeteer-core 24.43.1 已安装：`_extwork\e2e\node_modules`（Lead 负责 E2E，shell 可借用做冒烟测试）。
- 已 vendored：`浏览器扩展/lib/mp4-muxer.mjs`（mp4-muxer 5.2.2，MIT，**无外部依赖**）；License 在 `lib/LICENSE-mp4-muxer.txt`。
- 图标已由 Lead 生成：`浏览器扩展/icons/icon16.png|icon32.png|icon48.png|icon128.png`。
- 沙箱：只能写工作区；网络可用；shell 脚本/页面内**不得引用任何远程 CDN 或远程代码**（MV3 政策）。

---

## 1. 目录与写入范围（严格避免并发写冲突）

```
浏览器扩展/
├─ manifest.json                 # shell
├─ background.js                 # shell（MV3 service worker，type: module）
├─ popup/popup.html|css|js       # shell
├─ downloader/downloader.html|css|js  # shell（下载主界面 + 保存文件）
├─ icons/*.png                   # Lead 已生成（勿改）
├─ lib/mp4-muxer.mjs             # Lead 已放置（勿改）
├─ lib/LICENSE-mp4-muxer.txt     # Lead 已放置
├─ README.md                     # shell（中文安装/使用说明）
└─ src/core/                     # core 独占：hls 下载 + 解密 + TS 解复用 + MP4 封装
   ├─ index.mjs                  # 唯一对外入口（API 见 §3）
   └─ 其他 .mjs 自由拆分
```

- **core 只写** `浏览器扩展/src/core/**` 与 `_extwork/core-test/**`。
- **shell 只写** 上面标注 shell 的文件/目录 与 `_extwork/shell-test/**`。
- 都不要动 `lib/`、`icons/`、`downloads/`、`_tools/`、`HLS下载器/`。
- 所有 JS 用 **ES Module（.mjs 或带 type:module 的 .js）**，UTF-8 无 BOM；用户界面与 README 用中文。

---

## 2. 目标产物 / 行为

Chrome/Edge Manifest V3 扩展「HLS 视频下载器」：

1. **自动检测**：页面加载 m3u8 时（webRequest 监听），扩展图标显示蓝色数字角标；popup 列出当前标签页检测到的 m3u8 链接。
2. **解析信息**：popup 或下载页可显示片段数 / 总时长 / 是否加密 / master 码率列表。
3. **下载**：在扩展内（不经本地服务）并发下载片段 → AES-128 解密 → 按序拼接 → **直接封装为 MP4**（默认）或输出 TS；边下边写盘（流式，不能把整片都放内存）。
4. 进度条 / 速度 / ETA / 日志 / 取消；完成后提示文件保存位置（网页 File System Access API 保存）。
5. 支持手动粘贴任意 m3u8 链接。

---

## 3. 核心模块 API 契约（`src/core/index.mjs` 必须原样导出，shell 按此调用）

### 3.1 `probePlaylist(url, options)`

```js
export async function probePlaylist(url, options = {}) { ... }
// options: { signal?: AbortSignal, onLog?: (level:'info'|'warn'|'error', msg:string)=>void }
// 返回（全部字段必须存在）：
// {
//   url: string,              // 入参
//   finalUrl: string,         // 实际播放列表地址（master 时是选中的子播放列表？保持入参地址即可）
//   isMaster: boolean,
//   variants: Array<{ bandwidth: number, resolution: string|null, url: string }>,  // 非 master 时为 []
//   selectedUrl: string,      // 实际使用的媒体播放列表地址（master 自动选最高带宽）
//   segments: number,         // 媒体播放列表片段数（无法解析时为 0）
//   durationSeconds: number,
//   targetDuration: number,
//   encrypted: boolean,
//   encryptionMethods: string[], // 例如 ['AES-128']，未加密为 []
//   isLive: boolean,          // 无 ENDLIST 为 true
// }
```

### 3.2 `downloadHls(options)`

```js
export async function downloadHls(options) { ... }
// options:
// {
//   playlistUrl: string,                    // 必填
//   concurrency?: number,                   // 默认 16，范围 1..64
//   start?: number|null, end?: number|null, // 可选，秒；只下载覆盖区间的片段；MP4 输出再按时间戳过滤到该区间
//   timeoutMs?: number,                     // 单请求超时，默认 30000
//   retries?: number,                       // 单片段重试次数，默认 4
//   signal?: AbortSignal,                   // 取消
//   output: {
//     type: 'mp4' | 'ts',
//     // 位置感知写入（2026-11-08 追加，Lead 裁决）：
//     //   supportsPosition === true 时，write 允许第二参数 position（绝对偏移，覆盖写）；
//     //   用于 mp4-muxer fastStart:false 在 finalize 回填 offset 28 的 mdat size。
//     supportsPosition?: boolean,
//     write: (chunk: Uint8Array, position?: number|null) => Promise<void> | void,
//     // position == null 表示顺序追加；position != null 表示覆盖写入该绝对偏移。
//     // 串行 await；可被多次调用。旧式只接受一个参数的 write 也可工作（core 自动降级 fragmented MP4）。
//   },
//   onProgress?: (p: {
//     phase: 'playlist'|'download'|'decrypt'|'mux'|'done',
//     percent: number,                       // 0..100
//     segmentsDone: number, segmentsTotal: number,
//     bytesDownloaded: number,               // 已下载的加密分片字节数
//     speedBps: number, etaSeconds: number|null,
//     message?: string,
//   }) => void,
//   onLog?: (level:'info'|'warn'|'error', msg:string) => void,
// }
// 正常返回：
// {
//   durationSeconds: number,   // 输出媒体实际时长（秒）
//   segments: number,          // 实际下载的片段数
//   videoBytes: number,        // 写入视频编码数据的字节数（MP4 模式）；TS 模式可为 0
//   audioBytes: number,
//   muxed: boolean,            // true=MP4（走了 mp4-muxer），false=TS
//   elapsedMs: number,
//   width: number, height: number,          // 从 SPS 解析；无视频时为 0
//   sampleRate: number, channels: number,   // 从 ADTS 解析；无音频时为 0
// }
// 失败：抛 Error（带中文 message）；取消：抛名为 'AbortError' 的 DOMException/Error（shell 据此提示“已取消”）。
```

要求：

- **必须支持流式**：进度/写盘不能等全部下完；内存占用不能随视频总大小线性增长（只允许缓冲少量乱序片段 + 一个在处理的片段）。
- 并发下载、失败重试（指数退避）、`AbortSignal` 取消（取消后尽快停止，不再写 output）。
- 正确解析媒体播放列表与 master（选最高 `BANDWIDTH`），正确解析 `#EXT-X-KEY`（支持密钥轮换；IV 显式或默认=媒体序号 16 字节大端）。
- 解密：`crypto.subtle.decrypt({name:'AES-CBC', iv}, key, data)`；AES-128 的 key 是 16 字节；对 16 字节不对齐的密文要尝试处理；解密后去掉 PKCS#7 填充（校验填充值，异常时用 TS 同步字节 0x47 / 188 对齐兜底）。
- MP4：用 `../lib/mp4-muxer.mjs`（相对 core 的路径为 `../../lib/mp4-muxer.mjs`），`fastStart: false`，`StreamTarget({ chunked: true, chunkSize: 4*1024*1024 })`，`onData` 里把数据按顺序串行交给 `output.write`（用 Promise 链），`finalize()` 前要 await 所有未完成的写入。
- **时间戳单位是微秒**（mp4-muxer 约定，已验证）：视频 `addVideoChunkRaw(avccData, isKey?'key':'delta', ptsUs, durationUs, {decoderConfig:{codec:'avc', description: avcC}}, ptsMinusDtsUs)`；音频 `addAudioChunkRaw(aacRaw, 'key', ptsUs, durationUs, {decoderConfig:{codec:'aac', description: ascsBytes}})`。
  - `meta.decoderConfig.description` 是 `Uint8Array`（AVCDecoderConfigurationRecord / AudioSpecificConfig），mp4-muxer 直接写进 avcC/esds。
  - `firstTimestampBehavior: 'cross-track-offset'`（两条轨用同一 90kHz 时钟，保证音画同步）。
  - `video: {codec:'avc', width, height}`、`audio: {codec:'aac', numberOfChannels, sampleRate}` 由 TS 解析得到（SPS/ADTS），宽度高度必须正确。
- MP4 输出要求：**普通渐进式 MP4（moov 在文件末尾，fastStart:false 即可）**，ffmpeg/VLC/Chrome 可正常播放；视频为 H.264 Annex-B 转 AVCC（4 字节长度前缀），去掉 AUD 与 SPS/PPS 原始 NAL（SPS/PPS 放 avcC）；音频 ADTS 去头转为裸 AAC 帧。
- TS 输出要求：按片段顺序输出解密后的原始 TS 字节（ffmpeg 可解析）。

### 3.3 MP4 自检标准（core 必须自己跑通）

用真实流下载 **60–70 秒区间**（例如 `start: 60, end: 70`）到 `_extwork/core-test/out/clip.mp4`，然后：

```
_tools\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe -hide_banner -i clip.mp4
```

必须满足：`Duration` 约 10 秒（±0.5s）、`Video: h264 ... 1920x1080`、`Audio: aac ... 48000 Hz, stereo`、视频帧数约 240 帧、`ffmpeg -v error -i clip.mp4 -f null -` 无输出（无解码错误）。再用 `ffmpeg -ss 5 -i clip.mp4 -frames:v 1 out.jpg` 抽帧确认非黑屏。

TS 输出模式同样用 `downloadHls` 输出 10 秒 TS，ffmpeg 校验可解析出 h264+aac。

---

## 4. 扩展外壳（shell）契约

### 4.1 manifest.json（MV3，无远程代码）

- `permissions`: `webRequest`, `storage`, `tabs`, `activeTab`（按需增减，但不要过度授权）。
- `host_permissions`: `["<all_urls>"]`（扩展页面 fetch 跨域 m3u8/分片必需）。
- `background`: `{ "service_worker": "background.js", "type": "module" }`。
- `action`: `default_popup: "popup/popup.html"`，`default_icon` 用 icons/ 下 PNG。
- `icons`: 16/32/48/128。
- 不申请 `downloads`（保存用扩展页面的 `<a download>`/File System Access API 即可）。
- CSP 用默认（不得 eval/wasm）。

### 4.2 background.js（service worker）

- `chrome.webRequest.onBeforeRequest` 监听 `<all_urls>`，URL 含 `.m3u8`（不区分大小写）→ 记录 `{tabId, url, time}`（每标签页去重，最多保留 50 条；`chrome.storage.session` 持久化，SW 重启不丢）。
- 每个标签页用 `chrome.action.setBadgeText` 显示数量（0 时清空），`setBadgeBackgroundColor` 紫色 #6D3BFF。
- 消息 API（`chrome.runtime.onMessage`，`return true` 异步响应）：
  - `{type:'GET_CANDIDATES', tabId}` → `{candidates:[{url,time}], tabId}`
  - `{type:'CLEAR_CANDIDATES', tabId}` → `{ok:true}`
  - `{type:'GET_SETTINGS'}` / `{type:'SET_SETTINGS', settings}` → 设置存 `chrome.storage.local`：`{concurrency:16, format:'mp4'}`
- 标签页关闭时清理该 tab 记录（`chrome.tabs.onRemoved`）。

### 4.3 popup/popup.html

- 顶部品牌（复用图标）+ 当前标签页地址；候选 m3u8 列表（radio 选中，默认最新一条；每条可点“复制”）。
- 手动输入框（粘贴 m3u8 链接）+“解析”按钮：调用 `probePlaylist` 显示 片段数/时长/加密/清晰度（若有 master 变体）。
- 设置：并发数（默认 16）、输出格式（MP4 默认 / TS）。
- 主按钮：“开始下载”→ `chrome.tabs.create({url: downloader/downloader.html?url=...&format=...&concurrency=...})`。
- 无候选时给出提示：“先在本页播放视频，或手动粘贴 m3u8 链接”。
- 样式简洁美观（深色/浅色都行，别用远程字体/图标库，用内联 SVG 或 emoji）。

### 4.4 downloader/downloader.html（下载主界面，核心体验）

- 读取 URL 参数：`url`（必填）、`title`、`format`（mp4|ts，默认 mp4）、`concurrency`、`start`、`end`、`autosave`（0/1，E2E 用）。
- 打开后自动 `probePlaylist` 显示信息，并在用户点击“选择保存位置并开始”后：
  - `window.showSaveFilePicker({suggestedName: 'video_<id>.mp4', types:[...]})` 获得 `FileSystemWritableFileStream`；把 `write` 接到 `stream.write()`。
  - 不支持 FSA 或 `autosave=1` 时：用内存 Blob 分片收集，完成后 `new Blob(parts)` + `URL.createObjectURL` + `<a download>` 触发下载（文件名 `video_<id>.mp4`）。
  - 调 `downloadHls({playlistUrl, concurrency, start, end, output:{type, write}, onProgress, onLog})`。
- 界面组件：标题+链接、播放列表信息卡、进度条（百分比/片段数/已下载/速度/ETA/阶段文案）、日志区（可折叠）、取消按钮、完成后结果卡（文件大小、时长、分辨率、保存位置提示、“重新下载”）。
- 取消：`AbortController.abort()`，捕获 AbortError 显示“已取消”，不要留下半截文件（FSA 要 `stream.abort()`；Blob 模式丢弃即可）。
- 错误显示中文可读信息。
- **E2E 钩子（必须实现）**：页面把状态实时写到 `window.__HLS_STATE = {phase, percent, segmentsDone, segmentsTotal, error, done, filename, bytes}`；完成后写 `window.__HLS_RESULT = {done:true, filename, bytes, durationSeconds, muxed, pathHint}`，便于 puppeteer 断言。

### 4.5 README.md（中文）

- 安装：Chrome/Edge → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `浏览器扩展/` 目录。
- 使用：打开视频播放页 → 点扩展图标 → 选择检测到的 m3u8 → 开始下载；或手动粘贴。
- 保存位置说明（FSA 选目录/下载目录）、常见问题（CORS/Referer、证书、慢、取消、只支持 VOD AES-128）。
- 已知限制（仅 VOD、AES-128；SAMPLE-AES/DRM 不支持；扩展需 host_permissions `<all_urls>` 才能跨域抓流）。
- 附 E2E/自测结论（等 Lead 集成测试后由 Lead 补一段“已验证”内容，shell 先把结构留好）。

---

## 5. 测试与提交要求

- core：`_extwork/core-test/run.mjs`（用 Node 直接 import `src/core/index.mjs`，fetch 真实流，写文件到 `_extwork/core-test/out/`），必须包含：
  1. `probePlaylist` 断言 segments=1309、duration≈4988.7、encrypted=true；
  2. 10 秒 MP4 下载 + ffmpeg 校验（脚本里直接 spawn ffmpeg 并断言输出文本）；
  3. 10 秒 TS 下载 + ffmpeg 校验；
  4. 取消测试（AbortSignal 立即取消，确认 reject 且不再写）。
  运行：`node _extwork/core-test/run.mjs`，退出码 0 表示全过。把关键输出贴到给 Lead 的汇报里。
- shell：`node --check` 通过所有 JS；`_extwork/shell-test/smoke.mjs` 用 puppeteer-core + Chrome 以 `--load-extension` 加载扩展，至少验证：扩展能加载、background service worker 存在、popup 页面能打开无 console error、`chrome.runtime.getURL('downloader/downloader.html')` 可访问。Chrome 路径与 puppeteer 模块路径见 §0。
- 最终集成 E2E 由 Lead 负责（puppeteer 全流程：检测→下载→文件校验），两位在完成自身任务后通知 Lead。
- 汇报时给出：文件清单 + 运行命令 + 结果摘要 + 未验证/风险点。

## 6. 禁止事项

- 禁止引入远程 CDN/字体/脚本；禁止 eval/wasm；禁止申请 `<all_urls>` 以外的过度权限（host_permissions 是必须的）。
- 禁止把 node_modules、测试产物、临时文件放进 `浏览器扩展/`。
- 禁止修改不属于自己写入范围的文件；需要改动先发给 Lead。
- 禁止跳过真实流测试（只做静态检查不算完成）。
