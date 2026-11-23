# 视频下载器（Chrome / Edge 扩展）

![version](https://img.shields.io/badge/version-1.4.0-blue)
![license](https://img.shields.io/badge/license-%E9%9D%9E%E5%95%86%E4%B8%9A%20NonCommercial-orange)
![platform](https://img.shields.io/badge/Chrome%20%2F%20Edge-%E2%89%A5%20116-green)
![manifest](https://img.shields.io/badge/Manifest-V3-purple)

浏览器内直接下载网页视频的 Manifest V3 扩展，纯前端、无本地服务端、无远程代码。

支持：

- **通用 HLS（m3u8）**：自动检测 → 并发下载 → AES-128 解密 → 封装 MP4 / 保留 TS
- **B 站**：整段 MP4 直存；1080P 走 DASH 音视频合并，清晰度可选
- **抖音**：读页面自身数据拿播放地址与多档码率（支持信息流滑动切换、个人主页、历史记录）
- **腾讯视频**：官方 `getinfo` 接口，免费 / UGC 内容（270P / 480P / 720P）；DRM 版权内容明确拒绝
- **优酷**：页面上下文取 `ups` 播放信息 → HLS 分片 + AES-128；风控 / 会员内容明确提示

## 安装（加载已解压的扩展程序）

1. 打开 Chrome / Edge，进入 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 **`浏览器扩展/`** 目录（含 `manifest.json` 的那一层）
4. 建议固定到工具栏

详细说明、能力边界与验证记录见 **[`浏览器扩展/README.md`](浏览器扩展/README.md)**。

## 目录结构

```
.
├─ 浏览器扩展/            # 扩展源码（加载这个目录）
├─ HLS下载器/             # 早期 Python 版 HLS 下载器（历史版本）
├─ _extwork/              # 自测脚本（静态检查 / 单测 / 真实网络集成 / E2E）
├─ 视频下载器-浏览器扩展-v*.zip   # 各版本打包产物
└─ .gitignore
```

## 自测

```bash
node _extwork/shell-test/run-checks.mjs        # 静态检查 + 纯逻辑单测 + 后台逻辑单测
node _extwork/shell-test/integration-bilibili.mjs   # 真实网络（B 站）
node _extwork/shell-test/integration-tencent.mjs    # 真实网络（腾讯视频）
node _extwork/shell-test/e2e-tencent-download.mjs   # 整片下载 + ffmpeg 校验
node _extwork/shell-test/integration-youku.mjs      # 优酷（本机 IP 被风控时部分 SKIP）
```

> 真实浏览器内的 DNR / `scripting` 链路无法在命令行里自动化，需手动加载扩展确认。

## 免责声明

仅供个人备份与学习研究使用。请遵守目标网站的服务条款与当地法律法规，
仅下载你有权保存的内容；本项目不提供任何破解 DRM 或绕过付费 / 授权机制的能力。

## 使用协议

本项目采用**自定义非商业使用协议**，详见 [`LICENSE`](LICENSE)。要点：

- ✅ 允许：个人学习研究、备份自己有权保存的内容、保留署名的复制与修改
- ❌ 禁止：商业用途、侵犯著作权、绕过付费 / 会员 / 地区限制 / DRM、批量抓取与转售
- ⚠️ 免责：软件按「现状」提供，使用风险与法律责任由使用者自负
