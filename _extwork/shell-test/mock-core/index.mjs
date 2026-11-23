// 仅用于 shell 冒烟测试的 mock 核心模块。
// 该文件位于 `_extwork/shell-test/mock-core/`，冒烟测试会把扩展复制到 `_extwork/shell-test/build/ext/`
// 后用它替换 `src/core/index.mjs`；**绝不会**进入交付目录 `浏览器扩展/`。
//
// 注意：本 mock 只覆盖页面加载与后台逻辑所需的最小 API，不执行真实网络下载。

export async function probePlaylist(url) {
  return {
    url,
    finalUrl: url,
    isMaster: false,
    variants: [],
    selectedUrl: url,
    segments: 10,
    durationSeconds: 54,
    targetDuration: 5.4,
    encrypted: true,
    encryptionMethods: ['AES-128'],
    isLive: false,
  };
}

export async function downloadHls() {
  throw new Error('mock core：不执行真实下载（仅供冒烟测试页面加载）');
}
