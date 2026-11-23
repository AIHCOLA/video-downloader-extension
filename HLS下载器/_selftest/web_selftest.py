# -*- coding: utf-8 -*-
"""网页版自测脚本（回归验证用，日常使用不需要执行本文件）

做的事情：
1. 以子进程启动 ``app.py --no-browser``，从控制台输出解析实际监听地址（验证自动端口）；
2. 通过 HTTP API 验证：首页、/api/health、/api/defaults、/api/probe（真实链接解析）；
3. 创建真实下载任务（只下前 20 秒，并发 8），轮询进度直到完成，校验结果字段；
4. 用 ffmpeg 独立校验输出 MP4（时长/视频流/音频流），默认校验后删除测试视频；
5. 再创建一个完整下载任务并在下载中取消，验证取消功能与临时文件清理；
6. 调用 /api/shutdown 正常关闭服务，确认子进程退出。

用法::

    python _selftest/web_selftest.py            # 跑完整自测（下载 20 秒片段）
    python _selftest/web_selftest.py --keep     # 保留测试视频（默认删除）
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE = BASE_DIR.parent
SELFTEST_DIR = BASE_DIR / "_selftest"
APP_PATH = BASE_DIR / "app.py"
PYTHON = sys.executable
TARGET_URL = "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8"
_FFMPEG_CANDIDATES = sorted(
    (WORKSPACE / "_tools" / "imageio_ffmpeg" / "binaries").glob("ffmpeg*.exe")
)
FFMPEG = _FFMPEG_CANDIDATES[0] if _FFMPEG_CANDIDATES else Path("")

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> bool:
    if condition:
        PASS.append(name)
        print(f"  [PASS] {name}" + (f"  {detail}" if detail else ""), flush=True)
    else:
        FAIL.append(name)
        print(f"  [FAIL] {name}" + (f"  {detail}" if detail else ""), flush=True)
    return bool(condition)


def spawn_app(env: dict, extra_args: list[str] | None = None):
    """启动 app.py，返回 (proc, base_url, log_lines)。"""
    cmd = [PYTHON, str(APP_PATH), "--no-browser", "--port", "8765", "--log-level", "warning"]
    if extra_args:
        cmd.extend(extra_args)
    proc = subprocess.Popen(
        cmd, cwd=str(BASE_DIR),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    line_queue: "queue.Queue[str | None]" = queue.Queue()

    def _reader() -> None:
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line_queue.put(line.rstrip("\n"))
        finally:
            line_queue.put(None)

    threading.Thread(target=_reader, daemon=True).start()
    log_lines: list[str] = []
    base_url = None
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            item = line_queue.get(timeout=1.0)
        except queue.Empty:
            if proc.poll() is not None:
                break
            continue
        if item is None:
            break
        log_lines.append(item)
        match = re.search(r"(http://127\.0\.0\.1:\d+/)", item)
        if match:
            base_url = match.group(1).rstrip("/")
            break
    # 继续在后台收集日志
    def _logger() -> None:
        while True:
            try:
                item = line_queue.get(timeout=1.0)
            except queue.Empty:
                if proc.poll() is not None:
                    return
                continue
            if item is None:
                return
            log_lines.append(item)

    threading.Thread(target=_logger, daemon=True).start()
    return proc, base_url, log_lines


def progress_line(job: dict) -> str:
    progress = job.get("progress") or {}
    return (f"phase={progress.get('phase', '?')} "
            f"percent={progress.get('percent', 0):.1f}% "
            f"segments={progress.get('segments_done', 0)}/{progress.get('segments_total', 0)} "
            f"speed={progress.get('speed_text', '-')} "
            f"eta={progress.get('eta_text', '-')} "
            f"mb={progress.get('downloaded_text', '-')} "
            f"state={job.get('state')}")


def run_selftest(keep: bool) -> int:
    SELFTEST_DIR.mkdir(parents=True, exist_ok=True)
    output_path = SELFTEST_DIR / "web_clip20.mp4"
    for stale in (output_path, SELFTEST_DIR / "web_should_cancel.mp4"):
        if stale.exists():
            stale.unlink()

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    print("=" * 78, flush=True)
    print("HLS 下载器 · 网页版自测", flush=True)
    print("=" * 78, flush=True)
    print("[1] 启动 app.py 并等待实际监听地址 ...", flush=True)
    server_log: list[str] = []
    proc, base_url, log_lines = spawn_app(env)
    server_log = log_lines
    if not base_url:
        print("启动失败，服务端输出：", flush=True)
        print("\n".join(server_log[-40:]), flush=True)
        if proc.poll() is None:
            proc.terminate()
        return 1
    print(f"  [PASS] 服务已启动：{base_url}", flush=True)
    PASS.append("服务启动并监听 127.0.0.1")

    client = httpx.Client(base_url=base_url, timeout=120.0)
    job_id = None
    job = {}
    try:
        # ---- 基础接口 -------------------------------------------------
        print("\n[2] 基础接口与静态页面 ...", flush=True)
        index = client.get("/")
        check("GET / 返回网页", index.status_code == 200 and "HLS 视频下载器" in index.text,
              f"HTTP {index.status_code}, {len(index.text)} 字节")
        health = client.get("/api/health").json()
        check("GET /api/health", health.get("ok") is True, f"version={health.get('version')}")
        defaults = client.get("/api/defaults").json()
        print("  环境信息：" + json.dumps(defaults, ensure_ascii=False), flush=True)
        check("GET /api/defaults", bool(defaults.get("version")),
              f"ffmpeg_found={defaults.get('ffmpeg_found')}, aes={defaults.get('aes_backend')}")
        static_js = client.get("/static/app.js")
        check("GET /static/app.js", static_js.status_code == 200 and len(static_js.text) > 1000,
              f"HTTP {static_js.status_code}, {len(static_js.text)} 字节")

        # ---- 解析播放列表 ---------------------------------------------
        print("\n[3] /api/probe 解析真实播放列表 ...", flush=True)
        resp = client.post("/api/probe", json={"url": TARGET_URL})
        check("POST /api/probe", resp.status_code == 200, f"HTTP {resp.status_code}")
        summary = resp.json()["summary"]
        print("  解析结果：" + json.dumps(
            {k: summary[k] for k in ("segments", "duration_text", "encrypted",
                                     "encryption_methods", "is_master")},
            ensure_ascii=False), flush=True)
        check("播放列表片段数 = 1309", summary["segments"] == 1309,
              f"segments={summary['segments']}")
        check("识别 AES-128 加密", summary["encrypted"]
              and "AES-128" in summary["encryption_methods"],
              f"{summary['encryption_methods']}")

        # ---- 创建短片段下载任务 ---------------------------------------
        print("\n[4] 创建下载任务（0~20 秒，并发 8）...", flush=True)
        payload = {
            "url": TARGET_URL,
            "concurrency": 8,
            "start": 0,
            "end": 20,
            "output_dir": str(SELFTEST_DIR),
            "output_name": "web_clip20.mp4",
        }
        resp = client.post("/api/download", json=payload)
        check("POST /api/download", resp.status_code == 200, f"HTTP {resp.status_code}")
        data = resp.json()
        job_id = data["job_id"]
        print(f"  job_id={job_id}", flush=True)
        print(f"  output_path={data.get('output_path')}", flush=True)
        check("输出路径位于 _selftest",
              str(SELFTEST_DIR).lower() in str(data.get("output_path", "")).lower(),
              data.get("output_path", ""))

        deadline = time.time() + 300
        last_print = 0.0
        while time.time() < deadline:
            resp = client.get(f"/api/jobs/{job_id}")
            job = resp.json()["job"]
            now = time.time()
            if now - last_print >= 2.0 or job["state"] in ("done", "error", "cancelled"):
                print("  " + progress_line(job), flush=True)
                last_print = now
            if job["state"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.8)
        check("任务状态 = done", job.get("state") == "done",
              f"state={job.get('state')}, error={job.get('error')}")
        result = job.get("result") or {}
        print("  结果：" + json.dumps(
            {k: result.get(k) for k in ("output_path", "size_text", "duration_text",
                                        "segments_downloaded", "muxed", "video_streams",
                                        "audio_streams")},
            ensure_ascii=False), flush=True)
        check("结果包含输出文件", bool(result.get("output_path")))
        check("输出文件存在且非空", output_path.is_file() and output_path.stat().st_size > 0,
              f"{output_path.stat().st_size if output_path.exists() else 0} 字节")
        check("时长约 20 秒", result.get("duration_seconds", 0) and 19.0 <= float(result["duration_seconds"]) <= 21.5,
              f"{result.get('duration_seconds')} 秒")
        check("封装为 MP4（muxed=True）", result.get("muxed") is True)

        # ---- 独立用 ffmpeg 校验 ---------------------------------------
        print("\n[5] 用 ffmpeg 独立校验输出 MP4 ...", flush=True)
        if FFMPEG.is_file() and output_path.is_file():
            probe = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(output_path)],
                                   capture_output=True, text=True, encoding="utf-8",
                                   errors="replace",
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            ffmpeg_text = probe.stderr or ""
            for line in ffmpeg_text.splitlines():
                if line.strip().startswith(("Duration:", "Stream #", "Input #")):
                    print("  ffmpeg: " + line.strip(), flush=True)
            check("ffmpeg 可解析输出文件", "Duration:" in ffmpeg_text and "Stream #" in ffmpeg_text)
            check("ffmpeg 报告含 Video 流", "Video:" in ffmpeg_text)
            check("ffmpeg 报告含 Audio 流", "Audio:" in ffmpeg_text)
            match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", ffmpeg_text)
            if match:
                seconds = (int(match.group(1)) * 3600 + int(match.group(2)) * 60
                           + float(match.group(3)))
                check("ffmpeg 时长约 20 秒", 19.0 <= seconds <= 21.5, f"{seconds:.2f} 秒")
        else:
            check("ffmpeg 可用", FFMPEG.is_file(), str(FFMPEG))

        # ---- 只输出 TS（no_mp4 路径） ---------------------------------
        print("\n[5b] 网页版 no_mp4（只输出 TS，不调用 ffmpeg）...", flush=True)
        ts_output = SELFTEST_DIR / "web_clip6.ts"
        if ts_output.exists():
            ts_output.unlink()
        resp = client.post("/api/download", json={
            "url": TARGET_URL,
            "concurrency": 8,
            "start": 0,
            "end": 6,
            "output_dir": str(SELFTEST_DIR),
            "output_name": "web_clip6.ts",
            "no_mp4": True,
        })
        ts_job_id = resp.json()["job_id"]
        ts_job = {}
        deadline = time.time() + 240
        last_print = 0.0
        while time.time() < deadline:
            ts_job = client.get(f"/api/jobs/{ts_job_id}").json()["job"]
            now = time.time()
            if now - last_print >= 2.0 or ts_job["state"] in ("done", "error", "cancelled"):
                print("  " + progress_line(ts_job), flush=True)
                last_print = now
            if ts_job["state"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.8)
        ts_result = ts_job.get("result") or {}
        check("no_mp4 任务完成", ts_job.get("state") == "done",
              f"state={ts_job.get('state')}, error={ts_job.get('error')}")
        check("no_mp4 输出为 .ts 文件",
              ts_output.is_file() and ts_output.stat().st_size > 0,
              f"{ts_output.stat().st_size if ts_output.exists() else 0} 字节")
        check("no_mp4 未调用 ffmpeg（muxed=False）",
              ts_result.get("muxed") is False, f"muxed={ts_result.get('muxed')}")
        if ts_output.exists():
            ts_output.unlink()
            print("  已删除测试 TS 文件", flush=True)

        # ---- 取消功能 -------------------------------------------------
        print("\n[6] 取消功能：创建完整下载任务并在下载中取消 ...", flush=True)
        cancel_payload = {
            "url": TARGET_URL,
            "concurrency": 16,
            "output_dir": str(SELFTEST_DIR),
            "output_name": "web_should_cancel.mp4",
        }
        resp = client.post("/api/download", json=cancel_payload)
        cancel_job_id = resp.json()["job_id"]
        cancel_job = {}
        cancelled_state = None
        deadline = time.time() + 120
        while time.time() < deadline:
            cancel_job = client.get(f"/api/jobs/{cancel_job_id}").json()["job"]
            progress = cancel_job.get("progress") or {}
            if progress.get("segments_done", 0) >= 2:
                resp = client.post(f"/api/jobs/{cancel_job_id}/cancel")
                print("  已请求取消：" + json.dumps(resp.json(), ensure_ascii=False), flush=True)
                break
            if cancel_job["state"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.5)
        deadline = time.time() + 120
        while time.time() < deadline:
            cancel_job = client.get(f"/api/jobs/{cancel_job_id}").json()["job"]
            if cancel_job["state"] in ("done", "error", "cancelled"):
                cancelled_state = cancel_job["state"]
                break
            time.sleep(0.5)
        check("完整任务被取消", cancelled_state == "cancelled",
              f"state={cancelled_state}, error={cancel_job.get('error')}")
        cancel_out = SELFTEST_DIR / "web_should_cancel.mp4"
        check("取消后没有残留输出文件", not cancel_out.exists(),
              str(cancel_out))
        leftovers = [p.name for p in SELFTEST_DIR.glob(".hls_dl_*")]
        check("取消后没有残留临时目录", not leftovers, str(leftovers))

        # ---- 历史任务 -------------------------------------------------
        print("\n[7] /api/jobs 历史任务 ...", flush=True)
        jobs = client.get("/api/jobs").json()["jobs"]
        check("历史任务列表非空", len(jobs) >= 2, f"{len(jobs)} 个任务")
        print("  最近任务：" + json.dumps(
            [{"state": j["state"], "output": Path(j["output_path"]).name} for j in jobs[:4]],
            ensure_ascii=False), flush=True)

        # ---- 404 处理 -------------------------------------------------
        resp = client.get("/api/jobs/not-exist")
        check("不存在的任务返回 404", resp.status_code == 404, f"HTTP {resp.status_code}")

        # ---- 关闭服务 -------------------------------------------------
        print("\n[8] 关闭本地服务 ...", flush=True)
        resp = client.post("/api/shutdown")
        check("POST /api/shutdown", resp.status_code == 200)
    finally:
        client.close()

    try:
        exit_code = proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        exit_code = -9
    print(f"  服务进程退出码：{exit_code}", flush=True)
    check("app.py 正常退出", exit_code == 0, f"exit={exit_code}")
    actual_port = int(base_url.rsplit(":", 1)[1].rstrip("/"))
    check("关闭后端口已释放", _port_free(actual_port), f"port={actual_port}")

    # ---- 端口占用自动切换 ---------------------------------------------
    print("\n[9] 端口被占用时自动切换 ...", flush=True)
    import socket as _socket

    squatter = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    squatter.bind(("127.0.0.1", 8765))
    squatter.listen(1)
    try:
        proc2, base_url2, log2 = spawn_app(env)
        check("8765 被占用时仍能启动", bool(base_url2), base_url2 or "启动失败")
        check("自动切换到其他端口", bool(base_url2) and not base_url2.endswith(":8765"),
              base_url2 or "")
        if base_url2:
            health2 = httpx.get(base_url2 + "/api/health", timeout=20).json()
            check("切换后新端口服务可用", health2.get("ok") is True)
            httpx.post(base_url2 + "/api/shutdown", timeout=20)
        try:
            exit2 = proc2.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc2.kill()
            exit2 = -9
        check("端口冲突实例正常退出", exit2 == 0, f"exit={exit2}")
    finally:
        squatter.close()

    # ---- 收尾 ---------------------------------------------------------
    server_log = list(log_lines)
    log_path = SELFTEST_DIR / "web_selftest.log"
    report = {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base_url": base_url,
        "passed": PASS,
        "failed": FAIL,
        "server_log_tail": server_log[-60:],
    }
    log_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n自测日志已保存：{log_path}", flush=True)

    if not keep:
        for path in (output_path, SELFTEST_DIR / "web_should_cancel.mp4"):
            if path.exists():
                path.unlink()
                print(f"已删除测试视频：{path.name}", flush=True)

    print("\n" + "=" * 78, flush=True)
    print(f"结果：{len(PASS)} 项通过，{len(FAIL)} 项失败", flush=True)
    if FAIL:
        print("失败项：", flush=True)
        for item in FAIL:
            print("  - " + item, flush=True)
    print("=" * 78, flush=True)
    return 0 if not FAIL else 1


def _port_free(port: int) -> bool:
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="HLS 下载器网页版自测")
    parser.add_argument("--keep", action="store_true", help="保留测试生成的视频文件")
    args = parser.parse_args()
    return run_selftest(keep=args.keep)


if __name__ == "__main__":
    sys.exit(main())
