# shell-test：浏览器扩展外壳自检说明

本目录是 `浏览器扩展/` 外壳的开发自检脚本，**不会**被打包进扩展交付目录。

## 1. 一键自检（当前沙箱内可直接运行，退出码 0 = 全过）

```powershell
node _extwork/shell-test/run-checks.mjs
```

包含三步：

| 步骤 | 脚本 | 内容 |
| --- | --- | --- |
| 静态检查 | `static-check.mjs` | 交付文件齐全、`node --check` 全部 JS、manifest 字段/权限/图标、HTML 本地资源存在且无重复 id/无内联脚本/无远程资源、无 eval/new Function/wasm、JS 用到的 id 与 HTML 一致、E2E 钩子字段、README 章节、交付目录无测试产物 |
| 纯逻辑单测 | `unit-util.mjs` | 直接 import `浏览器扩展/downloader/util.mjs`：URL 参数解析、文件名规则、格式化、并发范围、阶段文案（55 项） |
| 后台逻辑单测 | `unit-background.mjs` | 用内存版 `chrome.*` mock import 真实 `background.js`：m3u8 检测/去重/大小写/50 条上限/时间倒序、`storage.session` 持久化、角标、GET/SET 消息 API、设置校验、`tabs.onRemoved` 清理（36 项） |

另有 **shell ↔ core 集成 / 位置感知写入回归检查**（真实网络、真实目标流、无需浏览器，手动运行）：

```powershell
node _extwork/shell-test/integration-core.mjs
```

以扩展调用方身份直接 import `浏览器扩展/src/core/index.mjs`，验证：

1. `probePlaylist` 字段齐全（1309 分片 / 4988.667 秒 / AES-128）；
2. **回归（>4MiB）**：`output.supportsPosition:true` + `write(chunk, position)` 下载 60–70 秒 MP4 →
   4.06 MiB、`moovFront=false`、ffmpeg `Duration=10.01s`、`Video: h264 (High)`、`Audio: aac 48000 Hz, stereo`、
   `ffmpeg -v error -i 文件 -f null -` **无 stderr 输出**（本次 mdat size 回填 bug 的回归测试）；
3. <4MiB 小片段对照（60–62 秒 → 0.83 MiB / 1.97s）；
4. TS 输出（60–70 秒 → 4.60 MiB / h264 + aac / 解码零错误）；
5. `AbortController` 取消 → `AbortError`，取消后无写入。

共 61 项断言；产物（`out/clip_60_70.mp4`、`out/clip_60_62.mp4`、`out/clip_60_70.ts`）保留在 `out/` 供人工复核。
需从目标站点下载约 9–10 秒视频（几 MB）。

## 2. 真实浏览器冒烟（需要能启动 Chrome 的环境）

```powershell
node _extwork/shell-test/smoke.mjs
# 可选：
#   SMOKE_HEADFUL=1        有界面模式
#   CHROME_PATH=...        指定 Chrome / Chrome for Testing
#   SMOKE_CORE=mock        强制 mock core（只验证外壳 UI）
#   SMOKE_NO_SANDBOX=1     追加 --no-sandbox
```

`smoke.mjs` 做这些事：

1. 启动 Chrome，`--disable-extensions-except` / `--load-extension` 指向扩展目录（正式版 Chrome 137+ 限制
   命令行加载扩展，请用 **Chrome for Testing**；脚本已附加 `--disable-features=DisableLoadExtensionCommandLineSwitch`）；
2. 等 Service Worker → 拿扩展 ID，校验 `chrome.runtime.getManifest()` 的 MV3 权限/入口；
3. 打开 `popup/popup.html`、`downloader/downloader.html`，收集 pageerror / console.error；
4. 通过后台消息 API 校验 GET/SET_SETTINGS；
5. 起本地 HTTP 服务模拟 m3u8，从普通页面发起请求，验证 `webRequest` 检测 → `GET_CANDIDATES` → 角标 → `CLEAR_CANDIDATES` 全链路；
6. 打开 `downloader.html?url=...&autosave=1`，等待自动 probe 进入 `ready`，校验 `window.__HLS_STATE` 字段齐全；
7. 输出 PASS/FAIL 汇总，退出码 0/1。

> ⚠️ **本 DSH 沙箱禁止进程创建命名管道**：Chromium/Chrome 在沙箱内会
> `FATAL:mojo platform_channel ... 拒绝访问(0x5)` 直接退出，Node `spawn` Chrome 也是 `EPERM`。
> 因此 `smoke.mjs` 无法在当前沙箱运行，真实浏览器 E2E 由 Lead 在提权环境 / 普通桌面用 Chrome for Testing 执行。
> 扩展 core 缺失时，`smoke.mjs` 会自动把扩展复制到 `build/ext` 并注入 `mock-core/index.mjs`（不污染交付目录）。

## 3. E2E 操作速查（给 Lead）

### 3.1 启动参数（推荐 Chrome for Testing）

```
--disable-extensions-except=<绝对路径>/浏览器扩展
--load-extension=<绝对路径>/浏览器扩展
--disable-features=DisableLoadExtensionCommandLineSwitch
--no-first-run --no-default-browser-check
```

### 3.2 打开下载页参数

```
chrome-extension://<EXT_ID>/downloader/downloader.html
  ?url=<encodeURIComponent(m3u8)>
  &format=mp4            # 或 ts
  &concurrency=16        # 1..64
  &autosave=1            # 跳过 showSaveFilePicker，Blob 模式 + <a download>
  &start=60&end=70       # 可选，秒
```

### 3.3 页面元素 / 操作

| 用途 | 选择器 |
| --- | --- |
| 开始下载按钮 | `#start`（`<button id="start">`） |
| 取消下载按钮 | `#cancel`（下载中才可用） |
| 开始秒 / 结束秒 | `#start-sec` / `#end` |
| 输出格式 / 并发 | `#format` / `#concurrency` |
| 日志区 | `#log` |
| 结果卡 | `#result-card` |

自动化建议流程：

```js
await page.goto(`chrome-extension://${extId}/downloader/downloader.html?${query}`);
await page.waitForFunction(() => window.__HLS_STATE && window.__HLS_STATE.phase === 'ready', { timeout: 60000 });
await page.click('#start');
await page.waitForFunction(() => window.__HLS_RESULT && window.__HLS_RESULT.done === true, { timeout: 180000 });
const result = await page.evaluate(() => window.__HLS_RESULT);
const bytes = await page.evaluate(async () => {
  const buf = await (await fetch(window.__HLS_BLOB_URL)).arrayBuffer();
  return buf.byteLength;
}); // 校验 bytes，无需处理浏览器下载目录
```

### 3.4 文件名规则（可预期）

`video_<视频标识>.<mp4|ts>`，视频标识取 m3u8 路径中 `index.m3u8` 前一段目录名（无上级目录时用域名，
非法字符转下划线）。目标流
`https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8` → **`video_aQWNV05d.mp4`**（TS 模式为 `.ts`）。
`autosave=1` 时 `window.__HLS_RESULT.filename` 与 `<a download>` 的 `download` 属性一致。

### 3.5 状态 / 结果钩子

- `window.__HLS_STATE = { phase, percent, segmentsDone, segmentsTotal, error, done, filename, bytes }`，实时更新；
  `phase ∈ idle | probe | ready | playlist | download | decrypt | mux | done | error | cancelled | cancelling`。
- 成功：`window.__HLS_RESULT = { done:true, filename, bytes, durationSeconds, muxed, moovFront, pathHint }`。
  `moovFront=false` 表示普通渐进式 MP4（moov 在文件末尾）；若为 `true` 说明核心退化为 fragmented MP4
  （位置感知写入未生效），E2E 应断言 `moovFront === false` 并用 ffmpeg 抽检文件。
- 取消：`__HLS_STATE.phase = 'cancelled'`、`error = '已取消'`、`done = false`，`__HLS_RESULT` 保持 `null`。
- Blob 模式额外暴露 `window.__HLS_BLOB_URL` / `window.__HLS_BLOB_SIZE`（fetch 可拿字节，用于文件校验）。
- `window.__HLS_START()` 可编程触发开始（等价点击 `#start`）。

### 3.6 取消测试建议

`autosave=1` 打开真实流 → 点击 `#start` → 等 `__HLS_STATE.phase === 'download'` 且 `percent > 0`
→ 点击 `#cancel` → 等 `window.__HLS_STATE.phase === 'cancelled'`，断言 `__HLS_RESULT === null`。

## 4. 目录

```
_extwork/shell-test/
├─ run-checks.mjs       # 一键自检（静态 + 单测，本沙箱可跑）
├─ static-check.mjs     # 静态检查
├─ unit-util.mjs        # util.mjs 单测
├─ unit-background.mjs  # background.js 单测（chrome.* mock）
├─ smoke.mjs            # puppeteer 冒烟（需可启动 Chrome 的环境）
└─ mock-core/index.mjs  # 仅供冒烟构建 mock 用，不进入交付目录
```
