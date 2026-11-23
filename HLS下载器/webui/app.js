/* HLS 视频下载器 · 本地网页版前端逻辑（原生 JS，无依赖） */
"use strict";

(function () {
  const CONC_MIN = 8;
  const CONC_MAX = 64;
  const STORAGE_KEY = "hlsDownloader.form.v1";

  const state = {
    jobId: null,
    pollTimer: null,
    pollErrors: 0,
    starting: false,
    outputPath: "",
    defaults: null,
    lastJob: null,
  };

  // ---------------------------------------------------------------- 工具

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function show(el) {
    if (el) el.classList.remove("hidden");
  }

  function hide(el) {
    if (el) el.classList.add("hidden");
  }

  function toast(message, ms) {
    const el = $("toast");
    if (!el) return;
    el.textContent = message;
    show(el);
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      hide(el);
    }, ms || 2600);
  }

  function parseOptionalNumber(value) {
    const text = String(value == null ? "" : value).trim();
    if (text === "") return null;
    const num = Number(text);
    return Number.isFinite(num) ? num : null;
  }

  async function api(path, options) {
    const opts = Object.assign({ method: "GET" }, options || {});
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const resp = await fetch(path, opts);
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      data = null;
    }
    if (!resp.ok) {
      let detail = "HTTP " + resp.status;
      if (data && data.detail) {
        detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      }
      throw new Error(detail);
    }
    return data;
  }

  // ---------------------------------------------------------------- 表单

  function setBusy(busy) {
    state.starting = busy;
    const startBtn = $("startBtn");
    startBtn.disabled = busy;
    startBtn.textContent = busy ? "创建任务中…" : "开始下载";
    $("probeBtn").disabled = busy;
  }

  function collectPayload() {
    const url = $("urlInput").value.trim();
    if (!url) throw new Error("请先填写 m3u8 链接");
    if (!/^https?:\/\//i.test(url)) throw new Error("链接必须以 http:// 或 https:// 开头");
    const start = parseOptionalNumber($("startInput").value);
    const end = parseOptionalNumber($("endInput").value);
    if (start !== null && end !== null && end <= start) {
      throw new Error("结束秒数必须大于开始秒数");
    }
    let concurrency = parseInt($("concInput").value, 10);
    if (!Number.isFinite(concurrency)) concurrency = CONC_DEFAULT;
    concurrency = Math.min(CONC_MAX, Math.max(CONC_MIN, concurrency));
    return {
      url: url,
      referer: $("refererInput").value.trim() || null,
      user_agent: $("uaInput").value.trim() || null,
      headers: $("headersInput").value.trim() || null,
      concurrency: concurrency,
      start: start,
      end: end,
      output_dir: $("outDirInput").value.trim() || null,
      output_name: $("outNameInput").value.trim() || null,
      keep_ts: $("keepTsInput").checked,
      no_mp4: $("noMp4Input").checked,
      verify_ssl: $("verifySslInput").checked,
    };
  }

  function saveForm() {
    try {
      const data = {
        url: $("urlInput").value,
        referer: $("refererInput").value,
        ua: $("uaInput").value,
        start: $("startInput").value,
        end: $("endInput").value,
        outDir: $("outDirInput").value,
        outName: $("outNameInput").value,
        conc: $("concInput").value,
        headers: $("headersInput").value,
        keepTs: $("keepTsInput").checked,
        noMp4: $("noMp4Input").checked,
        verifySsl: $("verifySslInput").checked,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* localStorage 不可用时忽略 */
    }
  }

  function restoreForm() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (e) {
      data = null;
    }
    if (!data) return;
    $("urlInput").value = data.url || "";
    $("refererInput").value = data.referer || "";
    $("uaInput").value = data.ua || "";
    $("startInput").value = data.start || "";
    $("endInput").value = data.end || "";
    $("outDirInput").value = data.outDir || "";
    $("outNameInput").value = data.outName || "";
    $("concInput").value = data.conc || "32";
    $("headersInput").value = data.headers || "";
    $("keepTsInput").checked = !!data.keepTs;
    $("noMp4Input").checked = !!data.noMp4;
    $("verifySslInput").checked = !!data.verifySsl;
    updateConcLabel();
  }

  function updateConcLabel() {
    $("concValue").textContent = $("concInput").value;
  }

  // ---------------------------------------------------------------- 环境信息

  async function loadDefaults() {
    try {
      const data = await api("/api/defaults");
      state.defaults = data;
      const badges = [];
      badges.push(
        '<span class="badge">版本 <b>v' + escapeHtml(data.version) + "</b></span>"
      );
      badges.push(
        '<span class="badge' + (data.aes_backend === "pycryptodome" ? " ok" : " warn") +
          '">AES 后端 <b>' + escapeHtml(data.aes_backend) + "</b></span>"
      );
      badges.push(
        '<span class="badge' + (data.ffmpeg_found ? " ok" : " warn") + '">ffmpeg ' +
          (data.ffmpeg_found ? "<b>已就绪</b>" : "<b>未找到</b>") + "</span>"
      );
      $("envBadges").innerHTML = badges.join("");
      $("footerVersion").textContent = "HLS 下载器 v" + data.version;
      $("outDirInput").placeholder =
        "留空 = " + (data.output_dir || "工作区 downloads/");
      if (!data.ffmpeg_found) {
        $("noMp4Input").checked = true;
      }
    } catch (e) {
      $("envBadges").innerHTML = '<span class="badge warn">环境信息获取失败</span>';
    }
  }

  // ---------------------------------------------------------------- 播放列表解析

  function finishProbe() {
    $("probeBtn").disabled = false;
    $("probeBtn").textContent = "解析链接";
  }

  async function probePlaylist() {
    let payload;
    try {
      payload = collectPayload();
    } catch (e) {
      toast(e.message);
      return;
    }
    $("probeBtn").disabled = true;
    $("probeBtn").textContent = "解析中…";
    try {
      const data = await api("/api/probe", {
        method: "POST",
        body: JSON.stringify({
          url: payload.url,
          referer: payload.referer,
          user_agent: payload.user_agent,
          headers: payload.headers,
          verify_ssl: payload.verify_ssl,
        }),
      });
      renderProbe(data.summary);
      // 若结束秒为空，用总时长做提示
      if (!$("endInput").value && data.summary.duration_seconds > 0) {
        $("endInput").placeholder =
          "如 20（全片约 " + data.summary.duration_text + "）";
      }
    } catch (e) {
      hide($("probeCard"));
      toast("解析失败：" + e.message, 4200);
    } finally {
      finishProbe();
    }
  }

  function renderProbe(summary) {
    if (!summary) return;
    const items = [];
    function item(key, value, wide) {
      items.push(
        '<div class="probe-item' + (wide ? " wide" : "") + '">' +
          '<span class="k">' + escapeHtml(key) + "</span>" +
          '<span class="v">' + escapeHtml(value) + "</span>" +
        "</div>"
      );
    }
    item("类型", summary.is_master ? "master（多码率）" : "媒体播放列表");
    item("片段数", String(summary.segments));
    item("总时长", summary.duration_text + "（" + summary.duration_seconds + " 秒）");
    item("加密", summary.encrypted ? (summary.encryption_methods || []).join(", ") : "未加密");
    if (summary.is_live) item("提示", "未发现 ENDLIST，可能是直播列表");
    if (summary.is_master && summary.variants && summary.variants.length) {
      const list = summary.variants
        .slice()
        .sort(function (a, b) {
          return (b.bandwidth || 0) - (a.bandwidth || 0);
        })
        .map(function (v) {
          return "<li>" + escapeHtml(v.describe || v.url) + "</li>";
        })
        .join("");
      items.push(
        '<div class="probe-item wide"><span class="k">码率变体</span>' +
          '<span class="v"><ul class="probe-variants">' + list + "</ul></span></div>"
      );
    }
    $("probeBody").innerHTML = items.join("");
    show($("probeCard"));
  }

  // ---------------------------------------------------------------- 下载流程

  function resetToIdle() {
    setBusy(false);
    hide($("cancelBtn"));
    hide($("progressCard"));
    hide($("resultCard"));
    hide($("errorCard"));
  }

  async function startDownload(event) {
    if (event) event.preventDefault();
    if (state.starting) return;
    let payload;
    try {
      payload = collectPayload();
    } catch (e) {
      toast(e.message);
      return;
    }
    saveForm();
    hide($("resultCard"));
    hide($("errorCard"));
    hide($("probeCard"));
    setBusy(true);
    try {
      const data = await api("/api/download", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.jobId = data.job_id;
      state.outputPath = data.output_path || "";
      state.pollErrors = 0;
      renderProgressShell();
      show($("progressCard"));
      show($("cancelBtn"));
      $("cancelBtn").disabled = false;
      $("cancelBtn").textContent = "取消下载";
      startPolling();
    } catch (e) {
      setBusy(false);
      hide($("progressCard"));
      showError("创建下载任务失败", e.message, hintForError(e.message));
    }
  }

  function renderProgressShell() {
    $("phaseLabel").textContent = "任务已创建…";
    $("progressMessage").textContent = "正在启动后台下载线程";
    $("percentText").textContent = "0%";
    $("progressBar").style.width = "0%";
    $("downloadedText").textContent = "-";
    $("speedText").textContent = "-";
    $("etaText").textContent = "-";
    $("segmentsText").textContent = "-";
    $("logBox").textContent = "";
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollJob, 700);
    pollJob();
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollJob() {
    if (!state.jobId) {
      stopPolling();
      return;
    }
    let data;
    try {
      data = await api("/api/jobs/" + encodeURIComponent(state.jobId));
    } catch (e) {
      state.pollErrors += 1;
      if (state.pollErrors >= 6) {
        stopPolling();
        showError("无法获取下载进度", e.message,
          "本地服务可能已关闭，请重新启动「启动网页版.bat」后重试。");
      }
      return;
    }
    state.pollErrors = 0;
    renderJob(data.job);
  }

  function renderJob(job) {
    if (!job) return;
    state.lastJob = job;
    const p = job.progress || {};
    const percent = Number.isFinite(Number(p.percent)) ? Number(p.percent) : 0;

    $("phaseLabel").textContent = p.phase_label || (job.state === "queued" ? "排队中…" : "处理中…");
    $("progressMessage").textContent = p.message || "";
    $("percentText").textContent = (job.state === "done" ? 100 : percent).toFixed(1) + "%";
    $("progressBar").style.width = (job.state === "done" ? 100 : percent) + "%";
    $("downloadedText").textContent = p.downloaded_text || "-";
    $("speedText").textContent =
      job.state === "download" || job.state === "running" ? p.speed_text || "-" : "-";
    $("etaText").textContent =
      job.state === "done" ? "已完成" : p.eta_text || "-";
    $("segmentsText").textContent =
      p.segments_total > 0 ? p.segments_done + " / " + p.segments_total : "-";
    renderLogs(job.logs || []);

    if (job.state === "done") {
      stopPolling();
      setBusy(false);
      hide($("cancelBtn"));
      showResult(job.result || {});
      refreshHistory();
    } else if (job.state === "error") {
      stopPolling();
      setBusy(false);
      hide($("cancelBtn"));
      showError("下载失败", job.error || "未知错误", hintForError(job.error || ""));
      refreshHistory();
    } else if (job.state === "cancelled") {
      stopPolling();
      setBusy(false);
      hide($("cancelBtn"));
      showError("已取消下载", job.error || "任务已被取消，未完成的临时文件已清理。", "");
      refreshHistory();
    } else {
      show($("cancelBtn"));
      $("cancelBtn").disabled = false;
    }
  }

  function renderLogs(logs) {
    const box = $("logBox");
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const html = logs.map(function (log) {
      const level = log.level || "info";
      let cls = "";
      let prefix = "·";
      if (level === "warn") { cls = "log-line-warn"; prefix = "!"; }
      if (level === "error") { cls = "log-line-error"; prefix = "×"; }
      return '<span class="' + cls + '">[' + escapeHtml(log.time) + "] " + prefix + " " +
        escapeHtml(log.message) + "</span>";
    }).join("\n");
    box.innerHTML = html;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function cancelDownload() {
    if (!state.jobId) return;
    const btn = $("cancelBtn");
    btn.disabled = true;
    btn.textContent = "正在取消…";
    try {
      await api("/api/jobs/" + encodeURIComponent(state.jobId) + "/cancel", { method: "POST" });
      toast("已请求取消，正在清理…");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "取消下载";
      toast("取消失败：" + e.message);
    }
  }

  // ---------------------------------------------------------------- 结果 / 错误

  function showResult(result) {
    const grid = $("resultGrid");
    state.outputPath = result.output_path || state.outputPath || "";
    const rows = [];
    function row(key, value, wide) {
      rows.push(
        "<div" + (wide ? ' class="wide"' : "") + "><dt>" + escapeHtml(key) +
          "</dt><dd>" + escapeHtml(value == null || value === "" ? "-" : value) + "</dd></div>"
      );
    }
    row("输出文件", result.output_path, true);
    row("文件大小", result.size_text);
    row("视频时长", result.duration_text + "（" + (result.duration_seconds || 0) + " 秒）");
    row("片段数量", String(result.segments_downloaded || "-"));
    row("下载流量", result.bytes_downloaded ? formatBytes(result.bytes_downloaded) : "-");
    row("总耗时", (result.elapsed_seconds || 0) + " 秒");
    row("封装方式", result.muxed ? "ffmpeg -c copy 封装 MP4" : "原始 TS 直出");
    row("AES 后端", result.aes_backend || "-");
    if (result.video_streams && result.video_streams.length) {
      row("视频流", result.video_streams.join("；"), true);
    }
    if (result.audio_streams && result.audio_streams.length) {
      row("音频流", result.audio_streams.join("；"), true);
    }
    if (result.ts_path) row("保留 TS", result.ts_path, true);
    grid.innerHTML = rows.join("");
    show($("resultCard"));
    $("errorCard").classList.add("hidden");
    $("resultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function formatBytes(num) {
    const n = Number(num) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function showError(title, message, hint) {
    $("errorCard").querySelector("h2").textContent = "❌ " + title;
    $("errorText").textContent = message || "未知错误";
    $("errorHint").textContent = hint || "";
    show($("errorCard"));
    $("errorCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function hintForError(message) {
    const text = String(message || "").toLowerCase();
    if (text.indexOf("403") >= 0) {
      return "站点拒绝访问（403）：请确认 Referer 正确（本站应为 https://vv.jisuzyv.com/），必要时在高级选项里自定义 Referer / UA / 附加请求头。";
    }
    if (text.indexOf("404") >= 0) {
      return "资源不存在（404）：m3u8 链接可能已过期，请重新获取最新播放地址。";
    }
    if (text.indexOf("ffmpeg") >= 0) {
      return "可以勾选「只输出 TS（不调用 ffmpeg）」后重试，或把 ffmpeg 放到 PATH / 设置 HLS_FFMPEG 环境变量。";
    }
    if (text.indexOf("ssl") >= 0 || text.indexOf("证书") >= 0 || text.indexOf("certificate") >= 0) {
      return "证书校验失败：本工具默认已跳过 HTTPS 证书校验（verify_ssl=false）；若仍然失败，请检查网络代理或站点是否可用。";
    }
    if (text.indexOf("超时") >= 0 || text.indexOf("timeout") >= 0) {
      return "网络超时：可降低并发数（例如 8~16）后重试，或检查网络连接。";
    }
    if (text.indexOf("取消") >= 0) {
      return "";
    }
    return "可展开「高级选项」调整 Referer、并发数或输出路径后重试。";
  }

  async function openFolder() {
    if (!state.jobId) return;
    try {
      const data = await api("/api/jobs/" + encodeURIComponent(state.jobId) + "/open-folder",
        { method: "POST" });
      if (!data.ok) toast(data.message || "无法打开文件夹");
    } catch (e) {
      toast("打开文件夹失败：" + e.message);
    }
  }

  async function copyPath() {
    const path = state.outputPath;
    if (!path) {
      toast("还没有可复制的结果路径");
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(path);
      } else {
        const area = document.createElement("textarea");
        area.value = path;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      toast("路径已复制到剪贴板");
    } catch (e) {
      toast("复制失败，请手动选择路径");
    }
  }

  function again() {
    hide($("resultCard"));
    hide($("errorCard"));
    if ($("urlInput").value.trim()) {
      $("urlInput").focus();
      $("urlInput").select();
    }
  }

  // ---------------------------------------------------------------- 历史任务

  async function refreshHistory() {
    try {
      const data = await api("/api/jobs");
      const jobs = data.jobs || [];
      const card = $("historyCard");
      const list = $("historyList");
      if (!jobs.length) {
        hide(card);
        return;
      }
      const stateText = {
        done: "已完成", error: "失败", cancelled: "已取消",
        running: "下载中", queued: "排队中",
      };
      list.innerHTML = jobs.map(function (job) {
        const cls = "state-" + (job.state || "queued");
        const label = stateText[job.state] || job.state;
        const path = job.output_path || (job.params && job.params.url) || "";
        return '<li class="history-item" data-job-id="' + escapeHtml(job.id) + '">' +
          '<span class="path">' + escapeHtml(path) + "</span>" +
          '<span class="state ' + cls + '">' + escapeHtml(label) + "</span>" +
          "</li>";
      }).join("");
      show(card);
      Array.prototype.forEach.call(list.querySelectorAll(".history-item"), function (el) {
        el.addEventListener("click", function () {
          loadJob(el.getAttribute("data-job-id"));
        });
      });
    } catch (e) {
      /* 历史列表不是核心功能，静默失败 */
    }
  }

  async function loadJob(jobId) {
    if (!jobId) return;
    try {
      const data = await api("/api/jobs/" + encodeURIComponent(jobId));
      const job = data.job;
      state.jobId = job.id;
      state.outputPath = job.output_path || "";
      hide($("probeCard"));
      renderProgressShell();
      show($("progressCard"));
      renderJob(job);
      if (job.state === "running" || job.state === "queued") {
        show($("cancelBtn"));
        startPolling();
      }
    } catch (e) {
      toast("加载任务失败：" + e.message);
    }
  }

  // ---------------------------------------------------------------- 初始化

  function bindEvents() {
    $("downloadForm").addEventListener("submit", startDownload);
    $("probeBtn").addEventListener("click", probePlaylist);
    $("cancelBtn").addEventListener("click", cancelDownload);
    $("openFolderBtn").addEventListener("click", openFolder);
    $("copyPathBtn").addEventListener("click", copyPath);
    $("againBtn").addEventListener("click", again);
    $("errorRetryBtn").addEventListener("click", again);
    $("probeCloseBtn").addEventListener("click", function () { hide($("probeCard")); });
    $("resultCloseBtn").addEventListener("click", function () { hide($("resultCard")); });
    $("errorCloseBtn").addEventListener("click", function () { hide($("errorCard")); });
    $("concInput").addEventListener("input", updateConcLabel);

    // Enter 键在链接输入框里直接开始下载
    $("urlInput").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        startDownload(event);
      }
    });
  }

  function init() {
    bindEvents();
    restoreForm();
    updateConcLabel();
    loadDefaults();
    refreshHistory();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
