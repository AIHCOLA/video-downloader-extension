/**
 * 站点适配器注册表。
 *
 * 新增站点时只需：
 *   1. 写一个 `xxx.mjs`，导出 `parseXxxUrl(input)` 与 `resolveXxx(input, options)`；
 *   2. 在下面的 SITES 里加一行。
 * 下载页只认 `detectSite(url)` 的返回值，不关心具体站点实现。
 */

import { parseBilibiliUrl, resolveBilibili, buildBilibiliFilename } from './bilibili.mjs';
import { parseDouyinUrl, resolveDouyin, buildDouyinFilename } from './douyin.mjs';
import { parseTencentUrl, resolveTencent, buildTencentFilename } from './tencent.mjs';
import { parseYoukuUrl, resolveYouku, buildYoukuFilename } from './youku.mjs';

export const SITES = [
  {
    id: 'bilibili',
    label: 'B站',
    match: parseBilibiliUrl,
    resolve: resolveBilibili,
    filename: (plan) =>
      buildBilibiliFilename({
        title: plan.title,
        bvid: plan.bvid,
        pageIndex: plan.page ? plan.page.index : 1,
        qualityLabel: plan.quality ? plan.quality.label : '',
      }),
  },
  {
    id: 'douyin',
    label: '抖音',
    match: parseDouyinUrl,
    resolve: resolveDouyin,
    filename: (plan) =>
      buildDouyinFilename({
        title: plan.title,
        awemeId: plan.awemeId,
      }),
  },
  {
    id: 'tencent',
    // label 会被拼成「检测到 ${label}视频」，所以这里用「腾讯」而不是「腾讯视频」
    label: '腾讯',
    match: parseTencentUrl,
    resolve: resolveTencent,
    filename: (plan) =>
      buildTencentFilename({
        title: plan.title,
        vid: plan.vid,
      }),
  },
  {
    id: 'youku',
    label: '优酷',
    match: parseYoukuUrl,
    resolve: resolveYouku,
    filename: (plan) =>
      buildYoukuFilename({
        title: plan.title,
        vid: plan.vid,
      }),
  },
];

/**
 * 识别 URL 属于哪个站点。
 * @returns {null | {id:string, label:string, parsed:object}}
 */
export function detectSite(input) {
  for (const site of SITES) {
    const parsed = site.match(input);
    if (parsed) return { id: site.id, label: site.label, parsed };
  }
  return null;
}

/** 按站点 id 取适配器 */
export function getSite(id) {
  return SITES.find((s) => s.id === id) || null;
}

/** 站点入口：解析成下载计划 */
export async function resolveSite(input, options = {}) {
  const site = detectSite(input);
  if (!site) throw new Error('暂不支持该站点的视频地址。');
  const adapter = getSite(site.id);
  return adapter.resolve(input, options);
}

/** 按解析计划生成保存文件名（各站点自己的命名规则） */
export function buildSiteFilename(plan) {
  if (!plan) return 'video.mp4';
  const adapter = getSite(plan.site);
  if (adapter && typeof adapter.filename === 'function') return adapter.filename(plan);
  return `${String(plan.title || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video'}.mp4`;
}
