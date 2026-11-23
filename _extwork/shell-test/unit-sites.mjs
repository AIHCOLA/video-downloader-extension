// 纯逻辑单测：B 站解析 + 直链下载核心。
//
// 覆盖：
//   - parseBilibiliUrl / pickPage / pickQuality / sanitizeFilenamePart /
//     buildBilibiliFilename / describeBilibiliError / assertApiOk（纯函数）
//   - parseTotalSize（标签页代理的分块解析）
//   - downloadDirect：流式写入、403 降级到分块代理、取消
//
// 不访问网络：direct 的测试用 stub 替换 globalThis.fetch。
//
// 用法：node _extwork/shell-test/unit-sites.mjs
// 退出码 0 = 全部通过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, '浏览器扩展');

const passes = [];
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes.push(label);
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}：期望 ${e}，实际 ${a}`);
    console.log(`FAIL  ${label}：期望 ${e}，实际 ${a}`);
  }
}

function ok(condition, label, detail) {
  if (condition) {
    passes.push(label);
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? `：${detail}` : ''}`);
    console.log(`FAIL  ${label}${detail ? `：${detail}` : ''}`);
  }
}

export async function runCheck() {
  console.log('=== B 站解析 + 直链下载 单测 ===');
  const bili = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'bilibili.mjs')).href);
  const sites = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'index.mjs')).href);
  const proxy = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'tab-proxy.mjs')).href);
  const direct = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'direct.mjs')).href);

  const {
    parseBilibiliUrl,
    pickPage,
    pickQuality,
    sanitizeFilenamePart,
    buildBilibiliFilename,
    describeBilibiliError,
    assertApiOk,
    QUALITY_TABLE,
    resolveBilibili,
    buildQualityOptions,
  } = bili;

  // ---- URL 解析 ----
  const v1 = parseBilibiliUrl('https://www.bilibili.com/video/BV1GbWq6HEct/?p=3&spm_id_from=333');
  eq({ kind: v1.kind, bvid: v1.bvid, page: v1.page }, { kind: 'video', bvid: 'BV1GbWq6HEct', page: 3 }, '解析带 ?p=3 的 BV 链接');
  const v2 = parseBilibiliUrl('https://m.bilibili.com/video/BV1GbWq6HEct');
  eq({ kind: v2.kind, bvid: v2.bvid, page: v2.page }, { kind: 'video', bvid: 'BV1GbWq6HEct', page: 1 }, '解析移动版链接');
  const v3 = parseBilibiliUrl('https://www.bilibili.com/video/av170001');
  eq({ kind: v3.kind, aid: v3.aid }, { kind: 'video', aid: 170001 }, '解析 av 号链接');
  eq(parseBilibiliUrl('BV1GbWq6HEct').bvid, 'BV1GbWq6HEct', '裸 BV 号');
  eq(parseBilibiliUrl('https://b23.tv/abcd123').kind, 'short', 'b23.tv 短链');
  eq(parseBilibiliUrl('https://www.bilibili.com/bangumi/play/ep123456').kind, 'bangumi', '番剧页被识别为 bangumi');
  eq(parseBilibiliUrl('https://example.com/video/BV1GbWq6HEct'), null, '非 B 站域名不匹配');
  eq(parseBilibiliUrl('https://www.bilibili.com/'), null, 'B 站首页不匹配');
  eq(parseBilibiliUrl(''), null, '空字符串返回 null');
  eq(parseBilibiliUrl('not a url'), null, '非法字符串返回 null');
  eq(parseBilibiliUrl('https://www.bilibili.com/video/BV1GbWq6HEct?p=abc').page, 1, '非法 p 参数回退到第 1 P');

  // 非 /video/ 路径的播放页（稍后再看 / 收藏夹 / 活动页），视频号在 query 里
  const q1 = parseBilibiliUrl('https://www.bilibili.com/list/watchlater?bvid=BV1GbWq6HEct&oid=12345');
  eq({ kind: q1.kind, bvid: q1.bvid }, { kind: 'video', bvid: 'BV1GbWq6HEct' }, '稍后再看 URL（query bvid）');
  const q2 = parseBilibiliUrl('https://www.bilibili.com/list/ml123456?bvid=BV1GbWq6HEct&oid=12345&p=2');
  eq({ kind: q2.kind, bvid: q2.bvid, page: q2.page }, { kind: 'video', bvid: 'BV1GbWq6HEct', page: 2 }, '收藏夹播放 URL 带分 P');
  const q3 = parseBilibiliUrl('https://www.bilibili.com/list/ml123456?oid=170001');
  eq({ kind: q3.kind, aid: q3.aid }, { kind: 'video', aid: 170001 }, '收藏夹历史 URL 只有 oid');
  const q4 = parseBilibiliUrl('https://www.bilibili.com/festival/2026?bvid=BV1GbWq6HEct');
  eq(q4 && q4.bvid, 'BV1GbWq6HEct', '活动页内嵌播放（query bvid）');
  eq(parseBilibiliUrl('https://www.bilibili.com/medialist/play/ml1?bvid=BV1GbWq6HEct').bvid, 'BV1GbWq6HEct', '旧版播单 URL');
  eq(parseBilibiliUrl('https://www.bilibili.com/'), null, 'B 站首页无视频号仍返回 null');
  eq(parseBilibiliUrl('https://example.com/list/watchlater?bvid=BV1GbWq6HEct'), null, '非 B 站域名不因 query 命中');

  // ---- 分 P ----
  const pages = [
    { cid: 11, page: 1, part: '第一集', duration: 100 },
    { cid: 22, page: 2, part: '第二集', duration: 200 },
  ];
  eq(pickPage(pages, 2), { cid: 22, index: 2, part: '第二集', durationSeconds: 200, total: 2 }, 'pickPage 取第 2 P');
  eq(pickPage(pages, 9).cid, 22, 'pickPage 越界时回退到最后一 P');
  eq(pickPage(pages, 0).cid, 11, 'pickPage 非法页码回退到第 1 P');
  eq(pickPage([], 1), null, 'pickPage 空数组返回 null');
  eq(pickPage(null, 1), null, 'pickPage null 返回 null');

  // ---- 清晰度 ----
  eq(pickQuality([64, 16], 64).label, '720P', 'pickQuality 选最高档 720P');
  eq(pickQuality([16, 32, 64, 80], 80).qn, 80, 'pickQuality 包含 1080P 时选 1080P');
  eq(pickQuality([], 32).label, '480P', 'pickQuality 空列表按返回值兜底');
  eq(pickQuality(null, 999).label, '未知', 'pickQuality 未知清晰度返回「未知」');
  ok(QUALITY_TABLE[80].width === 1920 && QUALITY_TABLE[80].height === 1080, 'QUALITY_TABLE 1080P 分辨率');

  // ---- 文件名 ----
  eq(sanitizeFilenamePart('a/b:c*d?e"f<g>h|i'), 'a b c d e f g h i', 'sanitize 替换 Windows 非法字符');
  eq(sanitizeFilenamePart('  结尾有点...  '), '结尾有点', 'sanitize 去掉结尾的点与空格');
  eq(sanitizeFilenamePart(''), 'video', 'sanitize 空字符串兜底 video');
  eq(sanitizeFilenamePart('x'.repeat(100), 10).length, 10, 'sanitize 截断到 maxLen');
  eq(
    buildBilibiliFilename({ title: '测试视频', bvid: 'BV1GbWq6HEct', pageIndex: 1, qualityLabel: '720P' }),
    '测试视频_BV1GbWq6HEct_720P.mp4',
    '文件名：标题_BV_清晰度'
  );
  eq(
    buildBilibiliFilename({ title: '多集', bvid: 'BV1GbWq6HEct', pageIndex: 3, qualityLabel: '1080P' }),
    '多集_BV1GbWq6HEct_P3_1080P.mp4',
    '文件名：多 P 带 P 序号'
  );
  const longName = buildBilibiliFilename({ title: '长'.repeat(200), bvid: 'BV1GbWq6HEct', pageIndex: 1, qualityLabel: '720P' });
  ok(longName.length <= 120 && longName.endsWith('.mp4'), '文件名总长度受限', `${longName.length} 字符`);

  // ---- 错误映射 ----
  ok(describeBilibiliError(-404, '').includes('不存在'), 'describeBilibiliError -404');
  ok(describeBilibiliError(87008, '').includes('大会员'), 'describeBilibiliError 大会员');
  ok(describeBilibiliError(-999, 'boom').includes('-999'), 'describeBilibiliError 未知码带 code');
  ok(describeBilibiliError(-999, '').length > 0, 'describeBilibiliError 未知码有文案');
  let threw = '';
  try {
    assertApiOk({ code: -404, message: '啥都没有' });
  } catch (err) {
    threw = err.message;
  }
  ok(threw.includes('不存在'), 'assertApiOk 抛中文错误', threw);
  eq(assertApiOk({ code: 0, data: { ok: 1 } }), { ok: 1 }, 'assertApiOk 成功返回 data');

  // ---- 解析链路：登录态（页面上下文）优先，失败回退匿名 ----
  const viewPayload = {
    code: 0,
    data: {
      bvid: 'BV1GbWq6HEct',
      aid: 1,
      title: '测试视频',
      owner: { name: 'UP' },
      pages: [{ cid: 111, page: 1, part: '正片', duration: 100 }],
      rights: {},
    },
  };
  const durl720 = {
    code: 0,
    data: {
      quality: 64,
      accept_quality: [64, 16],
      timelength: 100000,
      durl: [{ url: 'https://cdn.example.com/720.mp4', size: 1000, backup_url: [] }],
    },
  };
  const dash1080 = {
    code: 0,
    data: {
      timelength: 100000,
      dash: {
        duration: 100,
        video: [
          { id: 80, codecs: 'avc1.640032', bandwidth: 2000000, width: 1920, height: 1080, baseUrl: 'https://cdn.example.com/v80.m4s' },
          { id: 80, codecs: 'hev1.1.6', bandwidth: 1200000, width: 1920, height: 1080, baseUrl: 'https://cdn.example.com/v80-hevc.m4s' },
        ],
        audio: [
          { id: 30280, bandwidth: 128000, baseUrl: 'https://cdn.example.com/a-high.m4s' },
          { id: 30216, bandwidth: 64000, baseUrl: 'https://cdn.example.com/a-low.m4s' },
        ],
      },
    },
  };
  const dashAnon = {
    code: 0,
    data: {
      timelength: 100000,
      dash: {
        duration: 100,
        video: [
          { id: 32, codecs: 'avc1.64001e', bandwidth: 500000, width: 852, height: 480, baseUrl: 'https://cdn.example.com/v32.m4s' },
        ],
        audio: [{ id: 30280, bandwidth: 128000, baseUrl: 'https://cdn.example.com/a.m4s' }],
      },
    },
  };
  const navAnon = { code: 0, data: { isLogin: false } };
  const routeFetch = (routes) => async (url) => {
    for (const [key, payload] of Object.entries(routes)) {
      if (url.includes(key)) return { ok: true, json: async () => payload };
    }
    throw new Error(`未预期的请求：${url}`);
  };
  // DASH 与 durl 都走 playurl，用 fnval 区分
  const playRoutes = (dashPayload, durlPayload) => async (url) => {
    if (url.includes('web-interface/view')) return { ok: true, json: async () => viewPayload };
    if (url.includes('web-interface/nav')) return { ok: true, json: async () => navAnon };
    if (url.includes('player/playurl')) {
      if (url.includes('fnval=4048')) {
        if (!dashPayload) throw new Error('dash disabled');
        return { ok: true, json: async () => dashPayload };
      }
      if (!durlPayload) throw new Error('durl disabled');
      return { ok: true, json: async () => durlPayload };
    }
    throw new Error(`未预期的请求：${url}`);
  };

  // 登录态下 1080P 只在 DASH 里 → 走合并
  const plan1080 = await resolveBilibili('https://www.bilibili.com/video/BV1GbWq6HEct', {
    fetchImpl: playRoutes(dashAnon, durl720),
    fetchJsonInPage: async (url) => {
      if (url.includes('web-interface/nav')) {
        return {
          code: 0,
          data: {
            isLogin: true,
            wbi_img: {
              img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`,
              sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`,
            },
          },
        };
      }
      if (url.includes('fnval=4048')) return dash1080;
      return durl720;
    },
  });
  eq(plan1080.quality.label, '1080P', '页面上下文带登录态 → 拿到 1080P');
  eq(plan1080.mode, 'dash', '1080P 走 DASH 合并');
  eq(plan1080.video.url, 'https://cdn.example.com/v80.m4s', 'DASH 优先选 H.264 轨道');
  eq(plan1080.audio.url, 'https://cdn.example.com/a-high.m4s', '音频选最高码率');
  eq(plan1080.qualities.map((q) => q.qn), [80, 64], '下拉同时列出 1080P 与 720P');

  // 720P 能走整段 MP4 就直存，不折腾合并
  const plan720 = await resolveBilibili('https://www.bilibili.com/video/BV1GbWq6HEct', {
    fetchImpl: playRoutes(dashAnon, durl720),
    qn: 64,
  });
  eq(plan720.mode, 'file', '720P 走 durl 整段 MP4');
  eq(plan720.url, 'https://cdn.example.com/720.mp4', '直存地址来自 durl');
  eq(plan720.sizeBytes, 1000, '大小取 durl.size');

  // 只有 DASH、没有 durl 时也能下（走合并）
  const planDashOnly = await resolveBilibili('https://www.bilibili.com/video/BV1GbWq6HEct', {
    fetchImpl: playRoutes(dash1080, null),
  });
  eq(planDashOnly.mode, 'dash', 'durl 不可用时仍可用 DASH');
  eq(planDashOnly.quality.label, '1080P', 'DASH-only 仍是 1080P');

  // 一个可下载清晰度都没有 → 明确报错
  let emptyErr = '';
  try {
    await resolveBilibili('https://www.bilibili.com/video/BV1GbWq6HEct', {
      fetchImpl: playRoutes(
        { code: 0, data: { dash: { video: [{ id: 120, codecs: 'av01', baseUrl: 'x' }], audio: [] } } },
        null
      ),
    });
  } catch (err) {
    emptyErr = err.message;
  }
  ok(emptyErr.includes('没有可下载的清晰度'), '无 H.264 轨道时给出明确错误', emptyErr);

  // ---- WBI 签名 ----
  const wbiMod = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'wbi.mjs')).href);
  eq(wbiMod.md5(''), 'd41d8cd98f00b204e9800998ecf8427e', 'MD5 空串（RFC 1321 向量）');
  eq(wbiMod.md5('abc'), '900150983cd24fb0d6963f7d28e17f72', 'MD5 abc（RFC 1321 向量）');
  eq(wbiMod.md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0', 'MD5 message digest（RFC 1321 向量）');
  eq(wbiMod.md5('中文测试').length, 32, 'MD5 中文输入输出 32 位');
  eq(
    wbiMod.extractWbiKey('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'),
    '7cd084941338484aae1ad9425b84077c',
    'extractWbiKey 取文件名'
  );
  eq(wbiMod.extractWbiKey(''), '', 'extractWbiKey 空值返回空串');
  eq(wbiMod.getMixinKey('a'.repeat(32), 'b'.repeat(32)).length, 32, 'mixinKey 长度为 32');

  const wbiParams = { bvid: 'BV1GbWq6HEct', cid: 111, qn: 80, fnval: 1, fourk: 1 };
  const sigA = wbiMod.signWbi(wbiParams, 'k'.repeat(32), 's'.repeat(32), 1700000000);
  ok(sigA.query.includes('wts=1700000000'), '签名 query 带 wts');
  ok(/w_rid=[0-9a-f]{32}$/.test(sigA.query), '签名 query 以 32 位 w_rid 结尾', sigA.query.slice(-40));
  const sigB = wbiMod.signWbi({ ...wbiParams }, 'k'.repeat(32), 's'.repeat(32), 1700000000);
  eq(sigA.w_rid, sigB.w_rid, '同参数同时间戳签名可复现');
  const sigC = wbiMod.signWbi({ fourk: 1, fnval: 1, qn: 80, cid: 111, bvid: 'BV1GbWq6HEct' }, 'k'.repeat(32), 's'.repeat(32), 1700000000);
  eq(sigC.w_rid, sigA.w_rid, '参数顺序不影响签名（内部按 key 排序）');

  // ---- 清晰度下拉选项 ----
  const qualityOptions = buildQualityOptions([16, 120, 80, 64]);
  eq(qualityOptions.map((o) => o.qn), [120, 80, 64, 16], '清晰度按 qn 降序排列');
  eq(qualityOptions[0].label, '4K', '120 对应 4K');
  eq(qualityOptions[1].label, '1080P', '80 对应 1080P');
  eq(qualityOptions[0].supported, true, '列出的档位都标记为可用');
  eq(buildQualityOptions([999]), [], '未知 qn 被忽略');
  eq(buildQualityOptions([]), [], '空数组返回空列表');
  eq(buildQualityOptions(null), [], 'null 返回空列表');

  // 有 WBI 密钥时，两类请求都要走 wbi/playurl 且带签名
  const wbiUrls = [];
  const planWbi = await resolveBilibili('https://www.bilibili.com/video/BV1GbWq6HEct', {
    fetchImpl: playRoutes(dashAnon, durl720),
    fetchJsonInPage: async (url) => {
      if (url.includes('web-interface/nav')) {
        return {
          code: 0,
          data: {
            isLogin: true,
            wbi_img: {
              img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`,
              sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`,
            },
          },
        };
      }
      wbiUrls.push(url);
      return url.includes('fnval=4048') ? dash1080 : durl720;
    },
  });
  ok(wbiUrls.length > 0 && wbiUrls.every((u) => u.includes('/x/player/wbi/playurl')), '有 WBI 密钥时全部走 wbi/playurl');
  ok(wbiUrls.every((u) => /w_rid=[0-9a-f]{32}/.test(u)), '每个 wbi 请求都带 w_rid 签名');
  eq(planWbi.loggedIn, true, 'nav 的登录态写进计划');
  eq(planWbi.quality.label, '1080P', 'WBI 路径下取到 1080P');

  // qn 参数透传
  const planQn = await resolveBilibili('https://www.bilibili.com/video/BV1GbWq6HEct', {
    qn: 32,
    fetchImpl: playRoutes(dashAnon, durl720),
  });
  eq(planQn.requestedQn, 32, 'qn 参数透传');
  eq(planQn.selectedQn, 32, '选中请求的 320P 档（DASH 里有 480P 也按请求来）');

  // ---- 抖音（v1.2） ----
  const douyin = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'douyin.mjs')).href);
  eq(
    douyin.parseDouyinUrl('https://www.douyin.com/video/7300000000000000001'),
    { kind: 'video', awemeId: '7300000000000000001', normalized: 'https://www.douyin.com/video/7300000000000000001' },
    '抖音视频页解析'
  );
  eq(douyin.parseDouyinUrl('https://www.douyin.com/note/7300000000000000002').awemeId, '7300000000000000002', '抖音图文页解析');
  eq(douyin.parseDouyinUrl('https://v.douyin.com/iAbCdEf/').kind, 'short', '抖音短链');
  eq(
    douyin.parseDouyinUrl('https://www.douyin.com/discover?modal_id=7300000000000000003').awemeId,
    '7300000000000000003',
    'modal_id 形式'
  );
  eq(douyin.parseDouyinUrl('https://www.douyin.com/').kind, 'feed', '首页信息流识别为 feed');
  eq(douyin.parseDouyinUrl('https://www.douyin.com/jingxuan').kind, 'feed', '精选页（无 modal_id）识别为 feed');
  eq(douyin.parseDouyinUrl('https://www.douyin.com/discover?recommend=1').kind, 'feed', '推荐页识别为 feed');
  eq(douyin.parseDouyinUrl('https://www.douyin.com/?recommend=1').kind, 'feed', '带 recommend 参数识别为 feed');
  eq(douyin.parseDouyinUrl('https://www.bilibili.com/video/BV1GbWq6HEct'), null, '非抖音域名不匹配');
  // v1.2.3：直播间 / 登录等非内容页不识别
  eq(douyin.parseDouyinUrl('https://live.douyin.com/730000123456'), null, '直播间不支持');
  eq(douyin.parseDouyinUrl('https://www.douyin.com/login'), null, '登录页不算内容页');
  eq(douyin.parseDouyinUrl('https://www.douyin.com/setting'), null, '设置页不算内容页');
  // v1.2.3：个人主页 / 历史记录 / 搜索等页面统一识别为 page（取正在播的那条）
  eq(douyin.parseDouyinUrl('https://www.douyin.com/user/MS4wLjABAAAAxxxxx').kind, 'page', '个人/UP 主主页识别为 page');
  eq(
    douyin.parseDouyinUrl('https://www.douyin.com/user/self?showTab=history').kind,
    'page',
    '历史记录页识别为 page'
  );
  eq(douyin.parseDouyinUrl('https://www.douyin.com/user/self?showTab=post').kind, 'page', '个人作品列表页识别为 page');
  eq(douyin.parseDouyinUrl('https://www.douyin.com/search/%E7%8C%AB').kind, 'page', '搜索页识别为 page');
  eq(
    douyin.parseDouyinUrl('https://www.douyin.com/user/MS4wLjABAAAAxxxxx').normalized,
    'https://www.douyin.com/user/MS4wLjABAAAAxxxxx',
    'page 类型保留原地址'
  );

  const dyQualities = douyin.buildDouyinQualities([
    { label: '720P', width: 1280, height: 720, bitrate: 1200000, size: 2250000, url: 'https://v3.douyinvod.com/a.mp4', backups: ['https://b/a.mp4'] },
    { label: '1080P', width: 1920, height: 1080, bitrate: 2600000, size: 4800000, url: 'https://v3.douyinvod.com/b.mp4', backups: [] },
    { label: '坏数据', url: 'blob:xxx' },
  ]);
  eq(dyQualities.length, 2, 'buildDouyinQualities 过滤非 http 地址');
  eq(dyQualities[0].label, '1080P', 'buildDouyinQualities 按码率降序');

  const pageData = {
    ok: true,
    source: 'router',
    awemeId: '7300000000000000001',
    title: '测试作品 #话题',
    author: '某个作者',
    durationMs: 15000,
    qualities: [
      { label: '720P', width: 1280, height: 720, bitrate: 1200000, size: 2250000, url: 'https://v3.douyinvod.com/a.mp4', backups: ['https://b/a.mp4'] },
      { label: '1080P', width: 1920, height: 1080, bitrate: 2600000, size: 4800000, url: 'https://v3.douyinvod.com/b.mp4', backups: [] },
    ],
  };
  const dyPlan = await douyin.resolveDouyin('https://www.douyin.com/video/7300000000000000001', {
    extractPageData: async () => pageData,
  });
  eq(dyPlan.site, 'douyin', '抖音计划 site');
  eq(dyPlan.siteLabel, '抖音', '抖音计划 label');
  eq(dyPlan.mode, 'file', '抖音走整段 MP4');
  eq(dyPlan.quality.label, '1080P', '默认选最高码率');
  eq(dyPlan.url, 'https://v3.douyinvod.com/b.mp4', '下载地址取最高档');
  eq(dyPlan.sizeBytes, 4800000, '大小取 data_size');
  eq(dyPlan.durationSeconds, 15, '时长从毫秒换算');
  eq(dyPlan.referer, 'https://www.douyin.com/', '抖音计划带 Referer');
  eq(dyPlan.qualities.map((q) => q.label), ['1080P', '720P'], '抖音清晰度列表');
  eq(sites.buildSiteFilename(dyPlan), '测试作品 话题_7300000000000000001.mp4', '抖音文件名');

  const dy720 = await douyin.resolveDouyin('https://www.douyin.com/video/7300000000000000001', {
    extractPageData: async () => pageData,
    qn: 1200000,
  });
  eq(dy720.quality.label, '720P', '可按 qn 指定码率档');
  eq(dy720.url, 'https://v3.douyinvod.com/a.mp4', '指定档位后地址随之变化');

  let dyErr = '';
  try {
    await douyin.resolveDouyin('https://www.douyin.com/video/7300000000000000001', {
      extractPageData: async () => ({ ok: true, qualities: [] }),
    });
  } catch (err) {
    dyErr = err.message;
  }
  ok(dyErr.includes('没有可下载的视频'), '抖音无可用轨道时明确报错', dyErr);

  // ---- v1.2.3：page 类型（个人主页 / 历史记录）----
  let pageKindSeen = '';
  const pagePlan = await douyin.resolveDouyin('https://www.douyin.com/user/self?showTab=history', {
    extractPageData: async (_url, ctx) => {
      pageKindSeen = ctx.kind;
      return pageData;
    },
  });
  eq(pageKindSeen, 'page', 'page 类型把 kind 透传给提取端');
  eq(pagePlan.url, 'https://v3.douyinvod.com/b.mp4', 'page 类型提取成功后照常出计划');

  let pageErr = '';
  try {
    await douyin.resolveDouyin('https://www.douyin.com/user/MS4wLjABAAAAxxxxx', {
      extractPageData: async () => ({ ok: false, source: '', qualities: [] }),
    });
  } catch (err) {
    pageErr = err.message;
  }
  ok(pageErr.includes('没有正在播放'), 'page 类型识别失败时给出「先点开视频」的针对性提示', pageErr);

  // ---- 抖音页面提取（用假 DOM 在 Node 里跑页面函数） ----
  const pageDataMod = await import(pathToFileURL(path.join(EXT, 'src', 'core', 'page-data.mjs')).href);
  const aweme = {
    aweme_id: '7300000000000000001',
    desc: '凌晨的测试作品',
    author: { nickname: '某个作者' },
    video: {
      duration: 15000,
      play_addr: { url_list: ['https://v3.douyinvod.com/b.mp4', 'https://b/b.mp4'], width: 1920, height: 1080, data_size: 4800000 },
      bit_rate: [
        { gear_name: 'normal_1080_0', bit_rate: 2600000, play_addr: { url_list: ['https://v3.douyinvod.com/b.mp4'], width: 1920, height: 1080, data_size: 4800000 } },
        { gear_name: 'normal_720_0', bit_rate: 1200000, play_addr: { url_list: ['https://v3.douyinvod.com/a.mp4'], width: 1280, height: 720, data_size: 2250000 } },
      ],
    },
  };
  const routerData = { loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [aweme] } } } };
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const fakeDoc = (extra = {}) => ({
    title: '凌晨的测试作品-抖音',
    getElementById: () => null,
    querySelectorAll: () => [],
    ...extra,
  });
  try {
    globalThis.window = { _ROUTER_DATA: routerData };
    globalThis.document = fakeDoc();
    const routerOut = pageDataMod.extractDouyinInPage();
    eq(routerOut.ok, true, '页面提取：_ROUTER_DATA 命中');
    eq(routerOut.source, 'router', '页面提取：来源标记 router');
    eq(routerOut.awemeId, '7300000000000000001', '页面提取：拿到作品号');
    eq(routerOut.title, '凌晨的测试作品', '页面提取：标题');
    eq(routerOut.author, '某个作者', '页面提取：作者');
    eq(routerOut.durationMs, 15000, '页面提取：时长毫秒');
    eq(routerOut.qualities.length, 2, '页面提取：同地址的码率档去重');
    eq(
      routerOut.qualities.map((q) => [q.label, q.bitrate]),
      [['1080P', 2600000], ['720P', 1200000]],
      '页面提取：档位标签与码率'
    );

    // 老页面：RENDER_DATA
    globalThis.window = {};
    globalThis.document = fakeDoc({
      getElementById: (id) => (id === 'RENDER_DATA' ? { textContent: encodeURIComponent(JSON.stringify(routerData)) } : null),
    });
    const renderOut = pageDataMod.extractDouyinInPage();
    eq(renderOut.source, 'render', '页面提取：RENDER_DATA 兜底');
    eq(renderOut.qualities.length, 2, '页面提取：RENDER_DATA 也能取到档位');

    // 最后兜底：<video>.currentSrc
    globalThis.window = {};
    globalThis.document = fakeDoc({
      querySelectorAll: () => [
        { currentSrc: 'https://v3.douyinvod.com/paused.mp4', videoWidth: 1920, videoHeight: 1080, paused: true, ended: false },
        { currentSrc: 'https://v3.douyinvod.com/playing.mp4', videoWidth: 720, videoHeight: 1280, paused: false, ended: false },
      ],
    });
    const videoOut = pageDataMod.extractDouyinInPage();
    eq(videoOut.source, 'video', '页面提取：<video> 兜底');
    eq(videoOut.qualities[0].url, 'https://v3.douyinvod.com/playing.mp4', '页面提取：多个 <video> 时优先正在播的那个');
    eq(videoOut.qualities[0].height, 1280, '页面提取：<video> 取 videoHeight');

    // 什么都没有
    globalThis.window = {};
    globalThis.document = fakeDoc();
    eq(pageDataMod.extractDouyinInPage().ok, false, '页面提取：无数据时返回 ok=false');

    // 信息流：页面自己请求到的详情按 aweme_id 缓存（精选页/推荐页的唯一可靠来源）
    const makeAweme = (id, title, url) => ({
      aweme_id: id,
      desc: title,
      author: { nickname: '作者' + id },
      video: {
        duration: 8000,
        play_addr: { url_list: [url], width: 1080, height: 1920, data_size: 1234567 },
        bit_rate: [{ gear_name: 'normal_1080_0', bit_rate: 1500000, play_addr: { url_list: [url], width: 1080, height: 1920, data_size: 1234567 } }],
      },
    });
    const captureA = makeAweme('1111111111111111111', '第一个视频', 'https://v3.douyinvod.com/a1.mp4');
    const captureB = makeAweme('2222222222222222222', '第二个视频', 'https://v3.douyinvod.com/b1.mp4');
    globalThis.window = { __WB_AWEMES__: { '1111111111111111111': captureA, '2222222222222222222': captureB }, __WB_LAST_AWEME__: captureB };
    globalThis.document = fakeDoc();
    const capA = pageDataMod.extractDouyinInPage('1111111111111111111');
    eq([capA.source, capA.awemeId, capA.title], ['capture', '1111111111111111111', '第一个视频'], '页面提取：按 id 命中缓存（第一个视频）');
    eq(capA.qualities[0].url, 'https://v3.douyinvod.com/a1.mp4', '页面提取：命中缓存时地址属于对应作品');
    eq(capA.qualities[0].size, 1234567, '页面提取：缓存里有真实文件大小');
    const capB = pageDataMod.extractDouyinInPage('2222222222222222222');
    eq(capB.awemeId, '2222222222222222222', '页面提取：切换后按新 id 命中（修复点）');
    eq(capB.qualities[0].url, 'https://v3.douyinvod.com/b1.mp4', '页面提取：切换后地址跟着变');
    // 关键回归：要 id 333 时缓存里没有，绝不能把 222 的数据当成 333 返回
    eq(pageDataMod.extractDouyinInPage('3333333333333333333').ok, false, '页面提取：缓存不匹配时不返回上一条的数据');

    // 信息流页（没有 modal_id）：用「正在播的 <video>」去缓存里对齐当前作品
    globalThis.document = fakeDoc({
      querySelectorAll: () => [
        { currentSrc: 'https://v3.douyinvod.com/b1.mp4?sign=xx', videoWidth: 1080, videoHeight: 1920, paused: false, ended: false },
      ],
    });
    const feedOut = pageDataMod.extractDouyinInPage();
    eq(feedOut.source, 'capture-playing', '信息流：按正在播的地址对齐到缓存里的作品');
    eq(feedOut.awemeId, '2222222222222222222', '信息流：对齐到当前作品（不是上一条）');
    eq(feedOut.title, '第二个视频', '信息流：顺带拿到标题');
    eq(feedOut.qualities[0].size, 1234567, '信息流：顺带拿到文件大小');

    // 信息流但页面用 blob 播放 / 还没开始播：回退到「最近捕获」的那条（带新鲜度限制）
    globalThis.document = fakeDoc();
    globalThis.window = { __WB_AWEMES__: { '2222222222222222222': captureB }, __WB_LAST_AWEME__: captureB, __WB_LAST_AT__: Date.now() };
    const lastOut = pageDataMod.extractDouyinInPage();
    eq(lastOut.source, 'capture-last', '信息流：无可对齐播放地址时用最近捕获');
    eq(lastOut.awemeId, '2222222222222222222', '信息流：最近捕获的作品号');

    // 但过期的捕获不再采信（防止把很久以前那条当成当前）
    globalThis.window = { __WB_AWEMES__: { '2222222222222222222': captureB }, __WB_LAST_AWEME__: captureB, __WB_LAST_AT__: Date.now() - 10 * 60 * 1000 };
    eq(pageDataMod.extractDouyinInPage().ok, false, '信息流：过期的捕获不作为兜底');

    // v1.2.3 回归：page 类型（个人主页/历史记录）没有「当前正在播」的概念，
    // 猜「最近捕获」容易拿错作品，所以这条兜底只对信息流（feed）开放。
    globalThis.window = { __WB_AWEMES__: { '2222222222222222222': captureB }, __WB_LAST_AWEME__: captureB, __WB_LAST_AT__: Date.now() };
    globalThis.document = fakeDoc();
    eq(pageDataMod.extractDouyinInPage('', 'page').ok, false, 'page 类型：最近捕获不作为兜底');
    eq(pageDataMod.extractDouyinInPage('', 'feed').source, 'capture-last', 'feed 类型：最近捕获兜底仍然可用');

    // page 类型但页面上确实在播（主页里点开的弹层）：按正在播的地址对齐，照常拿到
    globalThis.document = fakeDoc({
      querySelectorAll: () => [
        { currentSrc: 'https://v3.douyinvod.com/b1.mp4?sign=xx', videoWidth: 1080, videoHeight: 1920, paused: false, ended: false },
      ],
    });
    const pagePlaying = pageDataMod.extractDouyinInPage('', 'page');
    eq(pagePlaying.source, 'capture-playing', 'page 类型：按正在播的地址对齐');
    eq(pagePlaying.awemeId, '2222222222222222222', 'page 类型：对齐到正在播的那条');

    // 典型现场：URL 还停在旧 modal_id，但画面已经滑到下一条 → 以画面为准
    const shortA = makeAweme('5555555555555555555', '五秒的视频', 'https://v3.douyinvod.com/a5.mp4');
    shortA.video.duration = 5000;
    const shortB = makeAweme('6666666666666666666', '九秒的视频', 'https://v3.douyinvod.com/b9.mp4');
    shortB.video.duration = 9000;
    globalThis.window = {
      __WB_AWEMES__: { '5555555555555555555': shortA, '6666666666666666666': shortB },
      __WB_LAST_AWEME__: shortB,
      __WB_LAST_AT__: Date.now(),
    };
    globalThis.document = fakeDoc({
      querySelectorAll: () => [
        { currentSrc: 'blob:https://www.douyin.com/abc', videoWidth: 1080, videoHeight: 1920, paused: false, ended: false, duration: 9 },
      ],
    });
    const stale = pageDataMod.extractDouyinInPage('5555555555555555555');
    eq(stale.awemeId, '6666666666666666666', '旧 modal_id + 画面已换：按播放时长判定为当前作品');
    eq(stale.title, '九秒的视频', '旧 modal_id + 画面已换：标题也跟着换');

    // 认不出是哪条、但当前画面地址可直下 → 至少能下（标题取页面文案）
    globalThis.window = { __WB_AWEMES__: {}, __WB_LAST_AWEME__: null, __WB_LAST_AT__: 0 };
    globalThis.document = fakeDoc({
      querySelectorAll: () => [
        { currentSrc: 'https://v3.douyinvod.com/unknown.mp4?sign=1', videoWidth: 720, videoHeight: 1280, paused: false, ended: false, duration: 3 },
      ],
      querySelector: (sel) => (sel.includes('video-desc') ? { textContent: '页面上的文案' } : null),
    });
    const rawVideo = pageDataMod.extractDouyinInPage('9999999999999999999');
    eq(rawVideo.source, 'video', '认不出作品时退回当前画面地址');
    eq(rawVideo.qualities[0].url, 'https://v3.douyinvod.com/unknown.mp4?sign=1', '退回时地址就是正在播的那条');
    eq(rawVideo.title, '页面上的文案', '退回时标题取页面文案');



  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }

  // ---- 捕获脚本本身（v1.2.2 的核心修复）----
  const captureCode = fs.readFileSync(path.join(EXT, 'src', 'page', 'douyin-capture.js'), 'utf8');
  const makeXhr = () => {
    function XHR() {
      this.listeners = {};
    }
    XHR.prototype.open = function open(_method, url) {
      this.url = url;
    };
    XHR.prototype.send = function send() {};
    XHR.prototype.addEventListener = function addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    };
    return XHR;
  };
  const runCapture = (payload) => {
    const XHR = makeXhr();
    const win = {
      XMLHttpRequest: XHR,
      fetch: async () => ({ clone: () => ({ text: async () => JSON.stringify(payload) }) }),
    };
    new Function('window', captureCode)(win);
    return win;
  };
  const feedPayload = {
    status_code: 0,
    aweme_list: [
      { aweme_id: '9000000000000000001', desc: '信息流第一条', video: { duration: 9000, play_addr: { url_list: ['https://v3.douyinvod.com/feed1.mp4'], width: 1080, height: 1920 } } },
      { aweme_id: '9000000000000000002', desc: '信息流第二条', video: { duration: 12000, play_addr: { url_list: ['https://v3.douyinvod.com/feed2.mp4'], width: 1080, height: 1920 } } },
    ],
  };
  const capWin = runCapture(feedPayload);
  await capWin.fetch('https://www.douyin.com/aweme/v1/web/tab/feed/?count=6');
  await new Promise((r) => setTimeout(r, 10));
  eq(Object.keys(capWin.__WB_AWEMES__ || {}).length, 2, '捕获脚本：tab/feed 批量响应里的作品被记录（v1.2.1 漏掉的正是这里）');
  eq(capWin.__WB_AWEMES__['9000000000000000001'].desc, '信息流第一条', '捕获脚本：按 aweme_id 建索引');
  ok(capWin.__WB_LAST_AT__ > 0, '捕获脚本：记录捕获时间');
  ok(capWin.__WB_SEQ__ >= 2, '捕获脚本：记录捕获序号');

  const capWin2 = runCapture({ status_code: 0, data: { foo: 1 } });
  await capWin2.fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123');
  await new Promise((r) => setTimeout(r, 10));
  eq(Object.keys(capWin2.__WB_AWEMES__ || {}).length, 0, '捕获脚本：非作品响应（无 aweme_list）不写入');
  eq(capWin2.__WB_LAST_AWEME__, null, '捕获脚本：不写入时保持为空');

  // ---- 抖音页面一致性判断（这次 bug 的核心）----
  eq(
    pageDataMod.samePageUrl('https://www.douyin.com/jingxuan?modal_id=111', 'https://www.douyin.com/jingxuan?modal_id=222'),
    false,
    'samePageUrl：同一个精选页、不同 modal_id 必须视为不同视频'
  );
  eq(
    pageDataMod.samePageUrl('https://www.douyin.com/jingxuan?modal_id=111', 'https://www.douyin.com/jingxuan?modal_id=111&x=2'),
    true,
    'samePageUrl：modal_id 相同（其余参数不同）视为同一个'
  );
  eq(
    pageDataMod.samePageUrl('https://www.douyin.com/video/123456789', 'https://www.douyin.com/video/123456789?previous_page=app'),
    true,
    'samePageUrl：路径里的作品号相同即同一个'
  );
  eq(
    pageDataMod.samePageUrl('https://www.douyin.com/video/123456789', 'https://www.douyin.com/video/987654321'),
    false,
    'samePageUrl：不同作品号不同'
  );
  eq(pageDataMod.samePageUrl('https://www.douyin.com/a', 'https://www.bilibili.com/a'), false, 'samePageUrl：不同站点不同');

  // ---- 站点注册表 ----
  eq(sites.detectSite('https://www.bilibili.com/video/BV1GbWq6HEct').id, 'bilibili', 'detectSite 命中 B 站');
  eq(sites.detectSite('https://example.com/a.m3u8'), null, 'detectSite 未命中返回 null');
  eq(sites.getSite('bilibili').label, 'B站', 'getSite 取到适配器');
  eq(sites.getSite('nope'), null, 'getSite 未知站点返回 null');
  eq(
    sites.buildSiteFilename({ site: 'bilibili', title: '标题', bvid: 'BV1GbWq6HEct', page: { index: 2 }, quality: { label: '720P' } }),
    '标题_BV1GbWq6HEct_P2_720P.mp4',
    'buildSiteFilename 走站点命名规则'
  );
  eq(sites.buildSiteFilename({ site: 'unknown', title: 'a/b' }), 'a b.mp4', 'buildSiteFilename 未知站点兜底');

  // ---- 代理分块解析 ----
  eq(proxy.parseTotalSize('bytes 0-1023/18504312'), 18504312, 'parseTotalSize 解析总大小');
  eq(proxy.parseTotalSize('bytes 0-1023/*'), 0, 'parseTotalSize 未知大小返回 0');
  eq(proxy.parseTotalSize(null), 0, 'parseTotalSize null 返回 0');

  // ---- downloadDirect：流式 ----
  const originalFetch = globalThis.fetch;
  try {
    const written = [];
    globalThis.fetch = async () =>
      new Response(new Blob([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), {
        status: 200,
        headers: { 'content-length': '5' },
      });
    const progress = [];
    const result = await direct.downloadDirect({
      url: 'https://cdn.example.com/a.mp4',
      sizeBytes: 5,
      output: { write: async (chunk) => written.push(chunk.byteLength) },
      onProgress: (p) => progress.push(p),
    });
    eq(written.reduce((a, b) => a + b, 0), 5, 'downloadDirect 流式写入字节数');
    eq(result.bytes, 5, 'downloadDirect 返回 bytes');
    eq(progress[progress.length - 1].phase, 'done', 'downloadDirect 最后阶段为 done');

    // 403 → 自动降级到分块代理
    const ranges = [];
    globalThis.fetch = async () => new Response(null, { status: 403 });
    const chunks = [];
    const result2 = await direct.downloadDirect({
      url: 'https://cdn.example.com/b.mp4',
      sizeBytes: 6,
      chunkSize: 4 * 1024 * 1024,
      output: { write: async (c) => chunks.push(c.byteLength) },
      fetchChunk: async (url, range) => {
        ranges.push([range.start, range.end]);
        return new Uint8Array(range.end - range.start + 1).fill(7);
      },
    });
    eq(ranges, [[0, 5]], '403 后改用代理分块（一次取完）');
    eq(result2.bytes, 6, '代理分块下载字节数正确');
    eq(chunks, [6], '代理分块只写一次');

    // 阻塞错误若没有代理实现 → 抛出可识别错误
    let blockedErr = null;
    globalThis.fetch = async () => new Response(null, { status: 403 });
    try {
      await direct.downloadDirect({
        url: 'https://cdn.example.com/c.mp4',
        sizeBytes: 10,
        output: { write: async () => {} },
      });
    } catch (err) {
      blockedErr = err;
    }
    ok(blockedErr && direct.isBlockedError(blockedErr), '无代理实现时抛出 isBlockedError 错误');

    // 取消
    const abortController = new AbortController();
    abortController.abort();
    let abortName = '';
    try {
      await direct.downloadDirect({
        url: 'https://cdn.example.com/d.mp4',
        output: { write: async () => {} },
        signal: abortController.signal,
      });
    } catch (err) {
      abortName = err.name;
    }
    eq(abortName, 'AbortError', 'downloadDirect 取消抛 AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---- 腾讯视频（v1.3） ----
  const tencent = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'tencent.mjs')).href);

  // URL 解析
  eq(
    tencent.parseTencentUrl('https://v.qq.com/x/page/y41026no22e.html'),
    { kind: 'video', vid: 'y41026no22e', normalized: 'https://v.qq.com/x/page/y41026no22e.html' },
    '腾讯 /x/page 播放页解析'
  );
  eq(
    tencent.parseTencentUrl('https://v.qq.com/x/cover/mzc002001bk7moh/w41029n1rrv.html').vid,
    'w41029n1rrv',
    '腾讯 /x/cover/<cid>/<vid> 解析出视频号'
  );
  eq(
    tencent.parseTencentUrl('https://v.qq.com/x/cover/mzc002001bk7moh/w41029n1rrv.html').cid,
    'mzc002001bk7moh',
    '腾讯 /x/cover/<cid>/<vid> 解析出专辑号'
  );
  eq(
    tencent.parseTencentUrl('https://v.qq.com/x/cover/mzc002001bk7moh.html').kind,
    'cover',
    '腾讯专辑页（没有视频号）识别为 cover'
  );
  eq(tencent.parseTencentUrl('https://v.qq.com/detail/mzc002001bk7moh.html').kind, 'cover', '腾讯 /detail 页识别为 cover');
  eq(
    tencent.parseTencentUrl('https://m.v.qq.com/x/m/play?vid=y41026no22e&cid=abc').kind,
    'video',
    '腾讯移动端 ?vid= 形式'
  );
  eq(
    tencent.parseTencentUrl('https://v.qq.com/txp/iframe/player.html?vid=y41026no22e').vid,
    'y41026no22e',
    '腾讯 iframe 播放器 ?vid= 形式'
  );
  eq(tencent.parseTencentUrl('https://www.bilibili.com/video/BV1GbWq6HEct'), null, '腾讯解析不误吃 B 站域名');
  eq(tencent.parseTencentUrl('https://www.douyin.com/video/7300000000000000001'), null, '腾讯解析不误吃抖音域名');

  // 伪 JSON 解析
  eq(
    tencent.parseGetinfoPayload('QZOutputJson={"s":"o","vl":{"vi":[]}};').s,
    'o',
    'getinfo 伪 JSON 去掉 QZOutputJson= 前缀'
  );
  let payloadErr = '';
  try {
    tencent.parseGetinfoPayload('<html>challenge</html>');
  } catch (err) {
    payloadErr = err.message;
  }
  ok(payloadErr.includes('无法解析'), 'getinfo 返回非 JSON 时明确报错', payloadErr);

  // DRM 判定
  eq(tencent.isDrmProtected({ drm: 1 }), true, 'DRM：vi.drm=1 判定为加密');
  eq(tencent.isDrmProtected({ drm: 0, enc: '1' }), true, 'DRM：enc=1 也判定为加密');
  eq(
    tencent.isDrmProtected({ drm: 0, enc: '0', encryption: '8265898' }),
    false,
    'DRM：免费视频的 encryption 常量不误判（实测踩过的坑）'
  );

  // 档位表
  const tencentFl = {
    fi: [
      { name: 'sd', cname: '流畅;(270P)', resolution: '270P', br: 14, fs: 741358, lmt: 0, drm: 0 },
      { name: 'hd', cname: '标清;(480P)', resolution: '480P', br: 33, fs: 1717137, lmt: 0, drm: 0 },
      { name: 'shd', cname: '准高清;(720P)', resolution: '720P', br: 58, fs: 3042108, lmt: 0, drm: 0 },
      { name: 'fhd', cname: '高清;(1080P)', resolution: '1080P', br: 90, fs: 9000000, lmt: 1, drm: 0 },
    ],
  };
  const tcQualities = tencent.buildTencentQualities(tencentFl);
  eq(tcQualities.map((q) => q.label), ['1080P', '720P', '480P', '270P'], '腾讯档位标签按分辨率取');
  eq(tcQualities.map((q) => q.qn), [90, 58, 33, 14], '腾讯档位 qn 用接口的 br');
  eq(tcQualities[0].supported, false, '腾讯会员专享档标为不可选');
  eq(tcQualities[1].supported, true, '腾讯免费档可选');

  // 播放地址拼装
  const tcVi = {
    fn: 'gzc_1000102_abc.f10217.mp4',
    fvkey: 'ABCDEF123456',
    ul: { ui: [{ url: 'http://a.tc.qq.com/dir' }, { url: 'http://b.tc.qq.com/dir/' }] },
  };
  eq(
    tencent.buildTencentPlayUrl(tcVi),
    'https://a.tc.qq.com/dir/gzc_1000102_abc.f10217.mp4?vkey=ABCDEF123456',
    '腾讯播放地址：镜像目录补斜杠 + vkey'
  );

  // 计划组装：探测档就是目标档时只请求一次
  const makeVi = (br, title, drm = 0) => ({
    vid: 'y41026no22e',
    cid: 'mzc002006266llu',
    ti: title,
    td: '50.07',
    fn: `gzc_1000102_abc.f${br}.mp4`,
    fvkey: `KEY${br}`,
    br,
    vw: 1280,
    vh: 720,
    fs: 3042108,
    drm,
    encryption: drm ? '8265898' : '',
    ul: { ui: [{ url: 'http://a.tc.qq.com/dir/' }, { url: 'http://b.tc.qq.com/dir/' }] },
  });
  const getinfoPayload = (vi) => ({ s: 'o', vl: { cnt: 1, vi: [vi] }, fl: tencentFl, ret_valid_tm: 3600 });
  const makeFetch = (handler) => {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      const body = handler(url);
      return { ok: true, status: 200, text: async () => `QZOutputJson=${JSON.stringify(body)};` };
    };
    impl.calls = calls;
    return impl;
  };

  tencent.resetThrottleForTest();
  const tcFetch = makeFetch(() => getinfoPayload(makeVi(58, '为婆家操劳多年仍是外人？蒋欣憋屈大哭')));
  const tcPlan = await tencent.resolveTencent('https://v.qq.com/x/page/y41026no22e.html', {
    fetchImpl: tcFetch,
    minGapMs: 0,
  });
  eq(tcFetch.calls.length, 1, '腾讯：探测档即目标档时只请求一次');
  eq(tcPlan.site, 'tencent', '腾讯计划 site');
  eq(tcPlan.siteLabel, '腾讯视频', '腾讯计划 label');
  eq(tcPlan.mode, 'file', '腾讯走整段 MP4');
  eq(tcPlan.quality.label, '720P', '腾讯默认取最高可用档');
  eq(tcPlan.url, 'https://a.tc.qq.com/dir/gzc_1000102_abc.f58.mp4?vkey=KEY58', '腾讯计划下载地址');
  eq(tcPlan.sizeBytes, 3042108, '腾讯计划大小取 fs');
  eq(tcPlan.durationSeconds, 50.07, '腾讯计划时长取 td');
  eq([tcPlan.quality.width, tcPlan.quality.height], [1280, 720], '腾讯计划分辨率取 vw/vh');
  eq(
    tcPlan.backupUrls,
    ['http://a.tc.qq.com/dir/gzc_1000102_abc.f58.mp4?vkey=KEY58', 'https://b.tc.qq.com/dir/gzc_1000102_abc.f58.mp4?vkey=KEY58'],
    '腾讯计划带备用镜像（原 http 主地址 + 其它镜像）'
  );
  eq(tcPlan.acceptLabels, ['1080P', '720P', '480P', '270P'], '腾讯计划列出全部档位');
  ok(String(tcPlan.qualityHint).includes('DRM'), '腾讯计划带清晰度说明', tcPlan.qualityHint);
  eq(
    sites.buildSiteFilename(tcPlan),
    '为婆家操劳多年仍是外人？蒋欣憋屈大哭_y41026no22e.mp4',
    '腾讯文件名：标题_视频号.mp4'
  );

  // 指定低档：需要再按该档的 defn 请求一次（每档文件名不同）
  tencent.resetThrottleForTest();
  const tcFetchLow = makeFetch((url) =>
    getinfoPayload(/defn=hd\b/.test(url) ? makeVi(33, '标清测试') : makeVi(58, '标清测试'))
  );
  const tcLow = await tencent.resolveTencent('https://v.qq.com/x/page/y41026no22e.html', {
    fetchImpl: tcFetchLow,
    qn: 33,
    minGapMs: 0,
  });
  eq(tcFetchLow.calls.length, 2, '腾讯：切到低档会按 defn 再请求一次');
  ok(/defn=hd\b/.test(tcFetchLow.calls[1]), '腾讯：第二次请求带上目标档 defn=hd', tcFetchLow.calls[1]);
  eq(tcLow.quality.label, '480P', '腾讯：按 qn 选中 480P');
  eq(tcLow.url, 'https://a.tc.qq.com/dir/gzc_1000102_abc.f33.mp4?vkey=KEY33', '腾讯：低档地址跟随档位变化');

  // DRM 内容：明确拒绝
  tencent.resetThrottleForTest();
  let tcDrm = '';
  try {
    await tencent.resolveTencent('https://v.qq.com/x/cover/mzc002001bk7moh/w41029n1rrv.html', {
      fetchImpl: makeFetch(() => getinfoPayload(makeVi(114, '第6期下', 1))),
      minGapMs: 0,
    });
  } catch (err) {
    tcDrm = err.message;
  }
  ok(tcDrm.includes('DRM'), '腾讯：DRM 内容给出明确提示', tcDrm);

  // 专辑页：提示点开具体一集
  tencent.resetThrottleForTest();
  let tcCover = '';
  try {
    await tencent.resolveTencent('https://v.qq.com/x/cover/mzc002001bk7moh.html', {
      fetchImpl: makeFetch(() => getinfoPayload(makeVi(58, '专辑'))),
      minGapMs: 0,
    });
  } catch (err) {
    tcCover = err.message;
  }
  ok(tcCover.includes('专辑'), '腾讯：专辑页提示先点开某一集', tcCover);

  // 业务错误码
  tencent.resetThrottleForTest();
  let tcGone = '';
  try {
    await tencent.resolveTencent('https://v.qq.com/x/page/y41026no22e.html', {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'QZOutputJson={"s":"f","em":61,"code":"61.2","msg":"该内容暂不可观看"};' }),
      minGapMs: 0,
    });
  } catch (err) {
    tcGone = err.message;
  }
  ok(tcGone.includes('暂不可观看'), '腾讯：61.x 错误码翻译成人话', tcGone);

  // 93.x 频率限制：退避后重试一次
  tencent.resetThrottleForTest();
  let tcRateCalls = 0;
  const tcRate = await tencent.resolveTencent('https://v.qq.com/x/page/y41026no22e.html', {
    minGapMs: 0,
    rateLimitBackoffMs: 0,
    fetchImpl: async () => {
      tcRateCalls += 1;
      const body = tcRateCalls === 1 ? { s: 'f', code: '93.2', msg: '该账号检测到有可疑违规' } : getinfoPayload(makeVi(58, '限流后重试成功'));
      return { ok: true, status: 200, text: async () => `QZOutputJson=${JSON.stringify(body)};` };
    },
  });
  eq(tcRateCalls, 2, '腾讯：93.x 时自动重试一次');
  eq(tcRate.quality.label, '720P', '腾讯：限流重试后仍能出计划');

  // 多段：当前明确不支持
  tencent.resetThrottleForTest();
  let tcSeg = '';
  try {
    await tencent.resolveTencent('https://v.qq.com/x/page/y41026no22e.html', {
      fetchImpl: makeFetch(() => ({ s: 'o', vl: { cnt: 2, vi: [makeVi(58, 'a'), makeVi(58, 'b')] }, fl: tencentFl })),
      minGapMs: 0,
    });
  } catch (err) {
    tcSeg = err.message;
  }
  ok(tcSeg.includes('多段'), '腾讯：分段视频明确提示暂不支持', tcSeg);

  // 站点注册表：腾讯已接入
  eq(sites.detectSite('https://v.qq.com/x/page/y41026no22e.html').id, 'tencent', 'detectSite 命中腾讯视频');
  eq(sites.getSite('tencent').label, '腾讯', 'getSite 取到腾讯适配器');

  // ---- 优酷（v1.4） ----
  const youku = await import(pathToFileURL(path.join(EXT, 'src', 'sites', 'youku.mjs')).href);

  // URL 解析
  eq(
    youku.parseYoukuUrl('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html'),
    { kind: 'video', vid: 'XNjQ0Mzc5ODQ4NA==', normalized: 'https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html' },
    '优酷 v_show 解析（含 base64 的 == 填充）'
  );
  eq(
    youku.parseYoukuUrl('https://m.youku.com/v_show/id_XNTkyODM2OTU2MA==.html?sharefrom=iphone').vid,
    'XNTkyODM2OTU2MA==',
    '优酷移动端 v_show 解析'
  );
  eq(
    youku.parseYoukuUrl('https://v.youku.com/v_nextstage/id_XNTE5OTU0NDU5Mg==.html').vid,
    'XNTE5OTU0NDU5Mg==',
    '优酷 v_nextstage 解析'
  );
  eq(youku.parseYoukuUrl('https://v.youku.com/video?vid=XNjQ0Mzc5ODQ4NA==').vid, 'XNjQ0Mzc5ODQ4NA==', '优酷 ?vid= 形式');
  eq(youku.parseYoukuUrl('https://www.youku.com/'), null, '优酷首页不识别');
  eq(youku.parseYoukuUrl('https://www.bilibili.com/video/BV1GbWq6HEct'), null, '优酷解析不误吃 B 站域名');

  // ups 地址拼装
  const upsUrl = youku.buildUpsUrl('XNjQ0Mzc5ODQ4NA==', { clientTs: 1794834 });
  ok(upsUrl.startsWith('https://ups.youku.com/ups/get.json?'), '优酷 ups 地址前缀正确', upsUrl);
  ok(/ccode=0564/.test(upsUrl), '优酷 ups 带 ccode=0564', upsUrl);
  ok(/utid=__CNA__/.test(upsUrl), '优酷 ups 默认用 __CNA__ 占位（页面里替换）', upsUrl);
  ok(/client_ts=1794834/.test(upsUrl), '优酷 ups 带 client_ts', upsUrl);
  ok(
    /utid=abc%2F123/.test(youku.buildUpsUrl('v', { utid: 'abc/123', clientTs: 1 })),
    '优酷 ups：真实 utid 会被 URL 编码'
  );

  // 错误码翻译
  ok(youku.describeYoukuError({ code: -6004, note: '该账号检测到有可疑违规' }).includes('风控'), '优酷 -6004 翻译成风控提示');
  ok(youku.describeYoukuError({ code: -6005, note: '用户账户异常' }).includes('登录'), '优酷 -6005 翻译成登录提示');
  ok(
    youku.describeYoukuError({ code: -6002, note: '因版权原因无法观看此视频' }).includes('地区'),
    '优酷版权限制翻译成地区提示'
  );

  // 档位整理：过滤 tail、按高度排序、同标签去重
  const upsStreams = [
    { stream_type: 'mp4hd2', width: 1280, height: 720, size: 5000000, m3u8_url: 'https://pl.youku.com/a.m3u8' },
    { stream_type: 'mp4hd3', width: 1920, height: 1080, size: 12000000, m3u8_url: 'https://pl.youku.com/b.m3u8' },
    { stream_type: 'mp4hd3', width: 1920, height: 1080, size: 15000000, m3u8_url: 'https://pl.youku.com/c.m3u8' },
    { stream_type: 'mp4', width: 640, height: 360, size: 900000, m3u8_url: 'https://pl.youku.com/d.m3u8' },
    { stream_type: 'mp4', width: 640, height: 360, size: 999999, m3u8_url: 'https://pl.youku.com/e.m3u8', channel_type: 'tail' },
    { stream_type: 'mp4', m3u8_url: 'blob:xxx' },
  ];
  const ykQualities = youku.buildYoukuQualities(upsStreams);
  eq(ykQualities.map((q) => q.label), ['1080P', '720P', '360P'], '优酷档位：按高度排序 + 过滤 tail/非法地址');
  eq(ykQualities[0].url, 'https://pl.youku.com/c.m3u8', '优酷档位：同高度保留体积最大的那条');
  eq(ykQualities[0].sizeBytes, 15000000, '优酷档位：大小取接口 size');

  const upsPayload = (over = {}) => ({
    data: {
      video: { title: '英美剧场：测试片段', seconds: 72.91, username: '英美剧场' },
      stream: upsStreams,
      ...over,
    },
  });

  // 计划组装（页面上下文优先）
  const ykPlan = await youku.resolveYouku('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html', {
    fetchJsonInPage: async (url) => {
      ok(/ups\.youku\.com\/ups\/get\.json/.test(url), '优酷解析：页面上下文请求的是 ups 接口', url);
      return upsPayload();
    },
  });
  eq(ykPlan.site, 'youku', '优酷计划 site');
  eq(ykPlan.siteLabel, '优酷', '优酷计划 label');
  eq(ykPlan.mode, 'hls', '优酷走 HLS 链路');
  eq(ykPlan.quality.label, '1080P', '优酷默认取最高档');
  eq(ykPlan.playlistUrl, 'https://pl.youku.com/c.m3u8', '优酷计划的 m3u8 地址');
  eq(ykPlan.sizeBytes, 15000000, '优酷计划大小');
  eq(ykPlan.durationSeconds, 72.91, '优酷计划时长');
  eq(ykPlan.owner, '英美剧场', '优酷计划作者');
  eq(ykPlan.acceptLabels, ['1080P', '720P', '360P'], '优酷计划列出全部档位');
  eq(
    sites.buildSiteFilename(ykPlan),
    '英美剧场：测试片段_XNjQ0Mzc5ODQ4NA.mp4',
    '优酷文件名：标题_视频号（去掉 = 填充；全角冒号是合法文件名字符）'
  );

  // 指定档位
  const yk720 = await youku.resolveYouku('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html', {
    fetchJsonInPage: async () => upsPayload(),
    qn: 720,
  });
  eq(yk720.playlistUrl, 'https://pl.youku.com/a.m3u8', '优酷：按 qn 选中 720P 的播放列表');

  // 业务错误：风控
  let ykErr = '';
  try {
    await youku.resolveYouku('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html', {
      fetchJsonInPage: async () => ({ data: { error: { code: -6004, note: '该账号检测到有可疑违规' } } }),
    });
  } catch (err) {
    ykErr = err.message;
  }
  ok(ykErr.includes('风控'), '优酷：接口风控错误明确提示', ykErr);

  // 页面上下文失败 → 直连回退（自己取 cna 当 utid）
  const ykCalls = [];
  const ykDirect = await youku.resolveYouku('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html', {
    fetchJsonInPage: async () => {
      throw new Error('页面上下文不可用');
    },
    fetchImpl: async (url, init = {}) => {
      ykCalls.push(url);
      if (/log\.mmstat\.com/.test(url)) {
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? '"CNA123456"' : null) },
          json: async () => ({}),
        };
      }
      ok(/utid=CNA123456/.test(url), '优酷回退：直连时 utid 用 mmstat 的 cna', url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => upsPayload() };
    },
  });
  eq(ykCalls.length, 2, '优酷回退：先取 cna 再请求 ups');
  eq(ykDirect.quality.label, '1080P', '优酷回退后仍能出计划');

  // 没有可用播放列表
  let ykEmpty = '';
  try {
    await youku.resolveYouku('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html', {
      fetchJsonInPage: async () => ({ data: { video: { title: '空' }, stream: [] } }),
    });
  } catch (err) {
    ykEmpty = err.message;
  }
  ok(ykEmpty.includes('没有返回可下载的播放列表'), '优酷：无可用档位时明确报错', ykEmpty);

  // 注册表
  eq(sites.detectSite('https://v.youku.com/v_show/id_XNjQ0Mzc5ODQ4NA==.html').id, 'youku', 'detectSite 命中优酷');
  eq(sites.getSite('youku').label, '优酷', 'getSite 取到优酷适配器');

  console.log('\n========== B 站 / 直链单测汇总 ==========');
  console.log(`通过：${passes.length}，失败：${failures.length}`);
  if (failures.length) console.log('失败：\n  - ' + failures.join('\n  - '));
  else console.log('结果：全部通过（exit 0）');
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCheck();
}
