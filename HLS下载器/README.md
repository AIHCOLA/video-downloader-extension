# HLS 视频下载器（本地网页版 + 命令行）

把 **m3u8（AES-128 加密）分段视频**下载、解密、拼接、封装成 **MP4** 的小工具包。
网页版双击启动、粘贴链接即可下载；也提供功能完整的命令行入口。

> 仅用于下载你有权保存的内容。

---

## 功能特性

- **播放列表解析**：支持媒体播放列表与 master（多码率）播放列表，master 自动选最高码率。
- **AES-128 解密**：支持显式 IV、缺省 IV=媒体序号、密钥轮换（多个 `EXT-X-KEY`）、`EXT-X-MAP` 初始化段（fMP4 基础支持）。
  优先使用 pycryptodome；缺失时回退到内置纯 Python AES-128 实现（可用但较慢）。
- **并发下载**：aiohttp 异步并发（1~128，默认 32，建议 8~64），失败按指数退避自动重试。
- **按序解密拼接**：边读边解密，避免整片占内存；然后调用 ffmpeg `-c copy` **无重编码**封装 MP4。
- **清晰报错**：HTTP 状态、Referer 提示、ffmpeg 失败尾部输出、找不到 ffmpeg 的替代方案。
- **进度与速度**：进度回调（阶段 / 百分比 / 片段数 / 已下载 / 速度 / ETA）、日志回调。
- **取消支持**：线程安全取消，取消后清理临时文件与半成品。
- **按秒裁剪**：`--start/--end` 只下载覆盖区间的片段，MP4 再精确裁剪（省流量）。
- **本地网页版**：只监听 `127.0.0.1`；端口被占用自动向后切换并打印实际地址；页面轮询进度条、速度、ETA、日志；完成后显示路径并支持「打开文件夹」「复制路径」。
- **无 requests 依赖**：网络层只用 aiohttp；网页版用 fastapi + uvicorn（本机环境已具备）。
- **路径自适配**：自动定位工作区 `_tools` 目录（嵌入式 Python 会忽略 `PYTHONPATH`）与 ffmpeg。
- **中文界面 / 中文文档 / UTF-8 源码**。

---

## 目录结构

```
HLS下载器/
├─ hls_core.py            # 核心模块：解析 / 下载 / 解密 / 拼接 / ffmpeg 封装 / 进度 / 取消
├─ hls_downloader.py      # 命令行入口（带进度条与最终文件信息）
├─ app.py                 # 本地网页版服务（FastAPI + uvicorn，127.0.0.1）
├─ webui/                 # 网页界面（纯本地，无 CDN）
│  ├─ index.html
│  ├─ style.css
│  └─ app.js
├─ 启动网页版.bat          # 双击启动网页版并自动打开浏览器
├─ README.md
└─ _selftest/             # 自测证据（测试视频已清理，只留日志与脚本）
   ├─ cli_selftest.log    #  命令行实测完整日志
   ├─ web_selftest.log    #  网页版实测报告（34 项全部通过）
   └─ web_selftest.py     #  网页版自测脚本（可重复运行）
```

---

## 运行环境

| 项目 | 本机实测环境 |
| --- | --- |
| 系统 | Windows 10/11 + PowerShell / cmd |
| Python | 3.12.0 嵌入式发行版（`E:\Python\python-3.12.0-embed-amd64`） |
| 网络库 | aiohttp 3.14.0 |
| 解密库 | pycryptodome（工作区 `_tools/Crypto`） |
| 网页框架 | fastapi 0.136.3 + uvicorn 0.49.0 + starlette |
| ffmpeg | `_tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe` |

要点：

- **嵌入式 Python 的 `python312._pth` 会忽略 `PYTHONPATH`**：`hls_core.py` 启动时会自动把最近的
  `_tools` 目录插入 `sys.path`；也可以用环境变量 `HLS_TOOLS_DIR` 显式指定。
- **ffmpeg 自动定位顺序**：环境变量 `HLS_FFMPEG` → `_tools/imageio_ffmpeg/binaries/ffmpeg*.exe`
  → `imageio_ffmpeg.get_ffmpeg_exe()` → `PATH` 中的 `ffmpeg`。找不到时会提示改用 `--no-mp4`。
- **HTTPS 证书**：本机环境访问该站点时证书链校验失败，工具默认 `verify_ssl=False`（跳过校验）；
  需要严格校验可加 `--verify-ssl`（本机通常会失败）。仅建议在可信网络使用。

---

## 快速开始

### 方式一：网页版（推荐，双击即用）

1. 双击 **`启动网页版.bat`**。
2. 会自动打开 <http://127.0.0.1:8765/>（端口被占用时自动换到下一个可用端口，实际地址打印在窗口里）。
3. 粘贴 m3u8 链接（如 `https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8`），点「开始下载」。
4. 页面实时显示进度条、速度、ETA 和日志；完成后显示输出路径，可「打开文件夹」/「复制路径」。

也可以命令行启动网页版：

```powershell
cd "…\default-workspace\HLS下载器"
python app.py                    # 默认 127.0.0.1:8765，自动开浏览器
python app.py --port 9000 --no-browser
python app.py --port 0           # 随机空闲端口
```

> `启动网页版.bat` 内容保持 ASCII（配合 `chcp 65001`）：实测 cmd.exe 解析含中文的 UTF-8 批处理会错行，
> 因此中文提示由 `app.py` 自己打印，最稳妥。

### 方式二：命令行

```powershell
# 下载整片：默认输出到工作区 downloads/ 目录，自动命名
python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8"

# 只下载前 20 秒（只下覆盖 0~20s 的 4 个片段，MP4 精确裁剪为 20s）
python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8" \
    --start 0 --end 20 --concurrency 48 -o downloads/clip20.mp4

# 只解析播放列表信息，不下载任何片段
python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8" --probe

# 只输出解密后的 TS（不调用 ffmpeg），并保留 TS
python hls_downloader.py "https://…/index.m3u8" --no-mp4 -o video.ts

# 自定义请求头 / Referer / UA
python hls_downloader.py "https://…/index.m3u8" \
    --referer "https://example.com/" --headers "Cookie: a=b" --user-agent "Mozilla/5.0 …"
```

> 目标站点需要浏览器 UA + Referer。工具默认带 Chrome UA，并按播放列表地址自动推导
> `Referer: https://vv.jisuzyv.com/`，通常无需手动填写。

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `url` | m3u8 播放列表地址（媒体列表或 master 列表均可） |
| `-o, --output` | 输出文件路径；缺省为 `<输出目录>/<自动命名>.mp4` |
| `--output-dir` | 输出目录；缺省为工作区 `downloads/` |
| `--headers "名称: 值"` | 附加请求头，可重复 |
| `--referer` | 自定义 Referer（缺省按链接推导站根目录） |
| `--user-agent` | 自定义 UA |
| `--concurrency N` | 并发数，默认 32，范围 1~128（本站建议 32~64） |
| `--start 秒` / `--end 秒` | 只下载覆盖该时间区间的片段；MP4 会精确裁剪 |
| `--retries N` | 单片段失败重试次数，默认 4（0 = 不重试） |
| `--keep-ts` | 额外保留解密拼接后的 TS 文件 |
| `--no-mp4` | 不调用 ffmpeg，直接输出 TS |
| `--verify-ssl` | 严格校验 HTTPS 证书（默认关闭） |
| `--probe` | 只解析播放列表并打印信息，不下载 |
| `-q, --quiet` / `-v, --verbose` | 安静模式 / 详细错误 |
| `--version` | 显示版本 |

退出码：`0` 成功；`1` 下载/解析失败；`2` 参数错误；`3` ffmpeg 封装失败；`130` 用户取消（Ctrl+C）。

---

## 输出目录与命名

- 默认输出目录：**工作区 `downloads/`**（即 `default-workspace/downloads/`）。
- 默认文件名：由播放列表 URL 推导，例如目标链接 → `aQWNV05d.mp4`；重名自动追加 `_2`、`_3`。
- 临时文件：输出文件同目录下的 `.hls_dl_*` 临时目录（存放加密片段与拼接结果），
  在完成 / 取消 / 失败后自动清理；`--keep-ts` 只保留最终 TS，不保留临时目录。
- 网页版中「输出目录」若填相对路径，按**工作区根目录**解析。

## 时间裁剪的语义

- `--start/--end` 只下载**覆盖该时间区间**的片段（整片段为单位），不下载整片。
- 封装 MP4 时再用 ffmpeg `-ss/-t` 把输出精确裁剪到区间（`-c copy`，关键帧对齐级别）。
- `--no-mp4` 输出的是整片段拼接的 TS，因此时长可能略大于区间（例如 0~6 秒会输出约 10.85 秒）。
- 实测：`--start 0 --end 20` → 下载 4 个片段（约 21.7 秒素材）→ 输出 **20.10 秒** MP4。

---

## 网页版 API（可选，便于脚本集成）

本地服务只监听 `127.0.0.1`，接口均为 JSON：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/defaults` | 版本、默认输出目录、ffmpeg/AES 后端、并发范围 |
| POST | `/api/probe` | 解析播放列表：`{url, referer?, user_agent?, headers?, verify_ssl?}` |
| POST | `/api/download` | 创建任务：`{url, concurrency?, start?, end?, output_dir?, output_name?, keep_ts?, no_mp4?, headers?, …}` → `{job_id, output_path}` |
| GET | `/api/jobs/{job_id}` | 任务状态：`state`、`progress`（百分比/速度/ETA/片段）、日志、结果 |
| POST | `/api/jobs/{job_id}/cancel` | 取消任务 |
| POST | `/api/jobs/{job_id}/open-folder` | 在资源管理器中定位文件 |
| GET | `/api/jobs` | 最近任务列表 |
| POST | `/api/shutdown` | 关闭本地服务（自测/便捷退出用） |

其中 `headers` 为多行文本，每行一个 `名称: 值`。

---

## 常见问题（FAQ）

1. **403 Forbidden / 站点拒绝访问**
   多半是 Referer 或 UA 不对。目标站点需要 `Referer: https://vv.jisuzyv.com/`，工具默认会自动推导；
   也可在网页「高级选项」或命令行 `--referer` 显式指定，必要时用 `--headers "Cookie: …"` 补充。

2. **HTTPS 证书校验失败**
   本机环境证书链校验会失败，工具默认 `verify_ssl=False` 跳过校验；`--verify-ssl` 可恢复严格校验。

3. **找不到 ffmpeg / 提示 FFmpegError**
   保持工作区 `_tools/imageio_ffmpeg/binaries/` 目录结构不变，或设置环境变量 `HLS_FFMPEG`，
   或把 `ffmpeg.exe` 加入 PATH。只想拿到视频的话直接用 `--no-mp4` 输出 TS。

4. **中文乱码**
   `启动网页版.bat` 已执行 `chcp 65001`；若在旧终端里用管道重定向输出，可先
   `set PYTHONIOENCODING=utf-8`。

5. **端口被占用**
   网页版会自动尝试下一个端口（默认从 8765 起），实际地址打印在窗口里；也可 `--port 0` 随机分配。

6. **下载速度慢**
   适当提高 `--concurrency`（本站建议 32~64）；片段数量多（本目标 1309 个）时并发太低会明显变慢。

7. **想中途取消**
   网页点「取消下载」，命令行按 `Ctrl+C`；临时文件和半成品会自动清理，不会留下坏文件。

8. **只想看看播放列表**
   用 `--probe` 或网页「解析链接」，只解析不下载，显示片段数、总时长、加密方式、master 码率列表。

9. **直播流 / 不支持的加密**
   只支持有 `EXT-X-ENDLIST` 的点播流；无 ENDLIST 会警告并按当前可见片段下载。
   仅支持 AES-128（AES-CBC），SAMPLE-AES、DRM（Widevine/FairPlay）和非 identity KEYFORMAT 会明确报错。

---

## 已验证（自测记录，2026-11-08）

环境：Python 3.12.0 嵌入式；aiohttp 3.14.0；fastapi 0.136.3；uvicorn 0.49.0；pycryptodome；ffmpeg 9.0.2。
目标链接：`https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8`（1309 个 AES-128 片段，总时长 **01:23:09**）。
**测试范围说明**：本工具只用短片段自测（整片 83 分钟由并行的另一个任务下载，不在本工具测试范围内）；
自测产生的视频文件已删除，仅保留日志与脚本。

### 1) 命令行实测（完整日志：`_selftest/cli_selftest.log`）

| 用例 | 命令（在工作区 `HLS下载器/` 下执行） | 结果 |
| --- | --- | --- |
| 解析播放列表 | `python hls_downloader.py <URL> --probe` | exit 0；1309 片段 / 01:23:09 / AES-128 |
| 短片段 MP4 + 保留 TS | `python hls_downloader.py <URL> --start 0 --end 20 --concurrency 8 --keep-ts -o _selftest/cli_clip20.mp4` | exit 0；4 片段 2.9 MB，耗时 5.7s；MP4 **2,803,936 字节 / 20.10 秒**；TS 3,061,768 字节 |
| 只出 TS（默认命名） | `python hls_downloader.py <URL> --start 0 --end 6 --no-mp4 --output-dir _selftest` | exit 0；自动命名 `aQWNV05d.ts`，1,081,940 字节 / 10.85 秒（2 个完整片段） |
| 参数校验（负向） | 错误 `--headers` 格式 / `--start 30 --end 20` / `ftp://` 链接 | 均按预期快速失败，exit 2 |

ffmpeg 独立校验上述 MP4（`ffmpeg -hide_banner -i cli_clip20.mp4`）：

```
Duration: 00:00:20.10, start: 0.000000, bitrate: 1115 kb/s
Stream #0:0: Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 988 kb/s, 24 fps
Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, 123 kb/s
```

解密正确性旁证：解密后的片段首字节为 TS 同步字节 `0x47`，ffmpeg 可正常解析出视频/音频流与时长。

### 2) 网页版实测（报告：`_selftest/web_selftest.log`，脚本：`_selftest/web_selftest.py`）

运行 `python _selftest/web_selftest.py`：**34 项检查全部通过、0 失败**。覆盖：

- 启动监听 `http://127.0.0.1:8765`；`/`、`/static/app.js`、`/api/health`、`/api/defaults` 正常。
- `/api/probe` 解析真实链接：1309 片段 / 01:23:09 / AES-128。
- 网页任务（0~20 秒，并发 8）：状态 `done`；输出 **2,803,936 字节 / 20.10 秒**，`muxed=true`，
  视频 `h264 1920x1080` + 音频 `aac 48000 Hz stereo`；ffmpeg 独立校验 Duration `00:00:20.10`。
- `no_mp4` 任务：输出 `.ts` 1,081,940 字节，`muxed=false`（未调用 ffmpeg）。
- **取消**：完整下载任务在下载中被取消 → 状态 `cancelled`，无残留输出文件、无残留临时目录。
- 历史任务列表与不存在的任务（404）处理正常。
- `POST /api/shutdown` 后进程退出码 0、8765 端口释放。
- **端口自动切换**：先占用 8765 再启动 → 自动使用 **8766**，新端口服务可用。

### 3) 核心逻辑验证（开发期）

- 内置纯 Python AES-128-CBC 通过 NIST SP 800-38A F.2.1 已知答案测试，并与 pycryptodome 交叉验证一致。
- m3u8 媒体/master 解析、`EXT-X-BYTERANGE`、密钥轮换、按秒裁剪的片段选择等用本地样例断言验证。
- 真实片段：下载 → AES-128 解密 → TS 同步字节校验 → ffmpeg 解析，全链路通过。

---

## 已知限制 / 未验证项

- 仅支持 **VOD（有 `EXT-X-ENDLIST`）**；直播/实时列表只能取当前可见片段（会打警告）。
- 仅支持 **AES-128（AES-CBC）**；SAMPLE-AES、DRM（Widevine / FairPlay）不支持。
- `EXT-X-MAP`（fMP4）只做了基础拼接支持，**未用真实 fMP4 流验证**。
- 整片下载（1309 片段 / 83 分钟）未由本工具验证；本次实测并发只到 16，
  **更高并发（32~64）的性能未在本次自测中验证**（目标站点建议值来自环境观察）。
- 不支持断点续传、HTTP 代理、限速；关闭网页服务会中断进行中的下载。
- 默认跳过 HTTPS 证书校验（本机证书链异常所致），不建议在不可信网络使用。
- `启动网页版.bat` 的「自动打开浏览器」使用 `webbrowser.open`，自动化测试中为避免弹窗未实际触发；
  其余启动链路（启动服务、监听 127.0.0.1、打印地址、API、关闭）均已验证。
- `启动网页版.bat` 与「打开文件夹」为 Windows 专用；Python 逻辑本身跨平台但未在 macOS/Linux 验证。
- 站点片段 URL 位于第三方 CDN 主机（`p.jisuts.com`），若该域名变更/失效，需要重新获取播放列表。

---

## 版本

v1.0.0 · 2026-11-08
