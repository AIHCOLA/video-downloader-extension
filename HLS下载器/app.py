# -*- coding: utf-8 -*-
"""HLS 视频下载器 · 本地网页版（app.py）

在 127.0.0.1 上启动一个本地网页服务，浏览器里粘贴 m3u8 链接即可下载：
后台线程调用 :mod:`hls_core` 下载，页面轮询进度条 / 速度 / ETA / 日志。

* 只监听回环地址 127.0.0.1，不对外暴露；
* 端口 8765 被占用时自动尝试下一个端口，并把实际地址打印到控制台；
* 网页静态资源在 ``webui/`` 目录，纯本地、无 CDN 依赖；
* 依赖：fastapi + uvicorn（已随嵌入式 Python 的 site-packages 提供）。
  若环境中没有，本文件会给出清晰提示（本工具环境已确认两者可用）。

启动方式::

    python app.py                # 打开 http://127.0.0.1:8765/
    python app.py --port 9000 --no-browser
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import hls_core as hc  # noqa: E402

WEBUI_DIR = BASE_DIR / "webui"

try:
    import uvicorn
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import FileResponse, JSONResponse, Response
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel, Field

    HAS_WEB_DEPS = True
    _WEB_DEPS_ERROR: Optional[BaseException] = None
except Exception as _exc:  # pragma: no cover - 依赖缺失时才触发
    HAS_WEB_DEPS = False
    _WEB_DEPS_ERROR = _exc

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_JOBS_KEPT = 30


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------


if HAS_WEB_DEPS:

    class ProbeRequest(BaseModel):
        """解析播放列表请求。"""

        url: str
        referer: Optional[str] = None
        user_agent: Optional[str] = None
        headers: Optional[str] = None
        verify_ssl: bool = False

    class DownloadRequest(ProbeRequest):
        """创建下载任务请求。"""

        concurrency: int = Field(default=hc.DEFAULT_CONCURRENCY,
                                 ge=hc.MIN_CONCURRENCY, le=hc.MAX_CONCURRENCY)
        retries: int = Field(default=hc.DEFAULT_RETRIES, ge=0, le=20)
        start: Optional[float] = Field(default=None, ge=0)
        end: Optional[float] = Field(default=None, ge=0)
        output_dir: Optional[str] = None
        output_name: Optional[str] = None
        keep_ts: bool = False
        no_mp4: bool = False


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def parse_headers_text(text: Optional[str]) -> Dict[str, str]:
    """把 ``每行一个 '名称: 值'`` 的文本解析成请求头字典。"""
    headers: Dict[str, str] = {}
    if not text:
        return headers
    for raw_line in str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"请求头格式应为 '名称: 值'，收到：{line!r}")
        name, _, value = line.partition(":")
        name, value = name.strip(), value.strip()
        if not name:
            raise ValueError(f"请求头名称为空：{line!r}")
        headers[name] = value
    return headers


def validate_url(url: str) -> str:
    """校验 m3u8 链接基本格式。"""
    text = (url or "").strip()
    if not text:
        raise ValueError("请填写 m3u8 链接")
    if not text.lower().startswith(("http://", "https://")):
        raise ValueError("链接必须以 http:// 或 https:// 开头")
    if len(text) > 4096:
        raise ValueError("链接过长")
    return text


def resolve_output_path(output_dir: Optional[str], output_name: Optional[str],
                        url: str, no_mp4: bool) -> Path:
    """计算下载任务的输出文件路径（网页版：相对目录按工作区根目录解析）。"""
    ext = ".ts" if no_mp4 else ".mp4"
    if output_dir and output_dir.strip():
        out_dir = Path(output_dir.strip()).expanduser()
        if not out_dir.is_absolute():
            out_dir = hc.workspace_root() / out_dir
    else:
        out_dir = hc.default_output_dir()

    if output_name and output_name.strip():
        name = Path(output_name.strip()).name  # 去掉路径分隔符，避免越界
        bad = '<>:"/\\|?*'
        name = "".join("_" if ch in bad else ch for ch in name).strip(" .")
        if not name:
            name = hc.default_output_name(url, ext)
        if not Path(name).suffix:
            name += ext
    else:
        name = hc.default_output_name(url, ext)
    return hc.unique_path(out_dir / name)


def open_in_explorer(path: str) -> bool:
    """在系统文件管理器里定位文件；失败返回 False。"""
    try:
        target = Path(path).expanduser().resolve()
    except OSError:
        return False
    if not target.exists():
        return False
    try:
        if os.name == "nt":
            subprocess.Popen(
                f'explorer /select,"{target}"',
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target.parent)])
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 下载任务
# ---------------------------------------------------------------------------


class Job:
    """一个后台下载任务，线程安全地保存进度、日志与结果。"""

    def __init__(self, job_id: str, params: Dict[str, Any], out_path: Path) -> None:
        self.id = job_id
        self.params = params
        self.out_path = str(out_path)
        self.state = "queued"  # queued/running/done/error/cancelled
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.error: Optional[str] = None
        self.result: Optional[Dict[str, Any]] = None
        self.progress: Dict[str, Any] = {}
        self.logs: List[Dict[str, str]] = []
        self.downloader: Optional[hc.HLSDownloader] = None
        self.thread: Optional[threading.Thread] = None
        self.cancel_requested = False
        self._lock = threading.Lock()

    # -- 回调（在下载线程/事件循环中调用） -------------------------------

    def update_progress(self, info: hc.ProgressInfo) -> None:
        with self._lock:
            self.progress = info.as_dict()

    def add_log(self, level: str, message: str) -> None:
        entry = {
            "time": time.strftime("%H:%M:%S"),
            "level": level,
            "message": str(message),
        }
        with self._lock:
            self.logs.append(entry)
            if len(self.logs) > 300:
                del self.logs[: len(self.logs) - 300]

    # -- 状态迁转 ---------------------------------------------------------

    def start(self) -> None:
        with self._lock:
            self.state = "running"
            self.started_at = time.time()

    def finish(self, result: hc.DownloadResult) -> None:
        with self._lock:
            self.result = result.as_dict()
            self.state = "done"
            self.finished_at = time.time()

    def fail(self, state: str, message: str) -> None:
        with self._lock:
            self.error = message
            self.state = state
            self.finished_at = time.time()

    def request_cancel(self) -> bool:
        self.cancel_requested = True
        downloader = self.downloader
        if downloader is not None:
            downloader.cancel()
        return downloader is not None

    def snapshot(self, include_logs: bool = True) -> Dict[str, Any]:
        with self._lock:
            data: Dict[str, Any] = {
                "id": self.id,
                "state": self.state,
                "progress": dict(self.progress),
                "result": dict(self.result) if self.result else None,
                "error": self.error,
                "output_path": self.out_path,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "elapsed_seconds": round(
                    (self.finished_at or time.time()) - (self.started_at or self.created_at), 2
                ),
                "params": {
                    key: value for key, value in self.params.items()
                    if key not in ("headers",)
                },
            }
            if include_logs:
                data["logs"] = list(self.logs)
            return data


class JobStore:
    """内存中的任务表。"""

    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def add(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
            # 只保留最近的若干任务（运行中的不清理）
            finished = [j for j in self._jobs.values()
                        if j.state in ("done", "error", "cancelled")]
            finished.sort(key=lambda j: j.created_at)
            while len(finished) > MAX_JOBS_KEPT:
                oldest = finished.pop(0)
                self._jobs.pop(oldest.id, None)

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list_recent(self, limit: int = 10) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        result = []
        for job in jobs[:limit]:
            result.append({
                "id": job.id,
                "state": job.state,
                "output_path": job.out_path,
                "created_at": job.created_at,
                "error": job.error,
                "result": job.result,
            })
        return result

    def running_jobs(self) -> List[Job]:
        with self._lock:
            return [j for j in self._jobs.values() if j.state in ("queued", "running")]


def run_download_job(job: Job, request: "DownloadRequest") -> None:
    """后台线程入口：调用 hls_core 完成下载。"""
    if job.cancel_requested:
        job.fail("cancelled", "任务在开始前已被取消")
        return
    job.start()
    job.add_log("info", "任务开始")
    try:
        headers = parse_headers_text(request.headers)
        downloader = hc.HLSDownloader(
            request.url,
            headers=headers,
            user_agent=request.user_agent,
            referer=request.referer,
            concurrency=request.concurrency,
            retries=request.retries,
            verify_ssl=request.verify_ssl,
            on_progress=job.update_progress,
            on_log=job.add_log,
        )
        job.downloader = downloader
        if job.cancel_requested:
            downloader.cancel()
        job.add_log("info", f"输出文件：{job.out_path}")
        result = downloader.download(
            job.out_path,
            start=request.start,
            end=request.end,
            keep_ts=request.keep_ts,
            no_mp4=request.no_mp4,
        )
        job.finish(result)
        job.add_log("info", "任务完成")
    except hc.DownloadCancelled:
        job.fail("cancelled", "已取消下载")
        job.add_log("warn", "用户取消了下载")
    except hc.FFmpegError as exc:
        job.fail("error", str(exc))
        job.add_log("error", f"ffmpeg 封装失败：{exc}")
    except hc.HLSError as exc:
        job.fail("error", str(exc))
        job.add_log("error", f"下载失败：{exc}")
    except Exception as exc:  # pragma: no cover - 兜底
        job.fail("error", f"{type(exc).__name__}: {exc}")
        job.add_log("error", f"未预期的错误：{type(exc).__name__}: {exc}")
    finally:
        downloader = job.downloader
        if downloader is not None:
            # 清理对下载器的引用，避免取消接口误操作已结束的任务
            job.downloader = None


# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------


def create_app() -> "FastAPI":
    app = FastAPI(title="HLS 视频下载器", version=hc.__version__,
                  docs_url=None, redoc_url=None, openapi_url=None)
    store = JobStore()
    app.state.store = store
    app.state.server = None

    if WEBUI_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(WEBUI_DIR)), name="static")

    # -- 页面 -------------------------------------------------------------

    @app.get("/")
    def index() -> "FileResponse":
        index_file = WEBUI_DIR / "index.html"
        if not index_file.is_file():
            return JSONResponse({"error": "缺少 webui/index.html"}, status_code=500)
        return FileResponse(str(index_file), media_type="text/html; charset=utf-8")

    @app.get("/favicon.ico")
    def favicon() -> "Response":
        return Response(status_code=204)

    # -- 基础信息 ---------------------------------------------------------

    @app.get("/api/health")
    def health() -> Dict[str, Any]:
        return {"ok": True, "version": hc.__version__, "time": time.time()}

    @app.get("/api/defaults")
    def defaults() -> Dict[str, Any]:
        ffmpeg = hc.find_ffmpeg()
        return {
            "version": hc.__version__,
            "output_dir": str(hc.default_output_dir()),
            "workspace": str(hc.workspace_root()),
            "concurrency_default": hc.DEFAULT_CONCURRENCY,
            "concurrency_min": hc.MIN_CONCURRENCY,
            "concurrency_max": hc.MAX_CONCURRENCY,
            "aes_backend": hc.aes_backend_name(),
            "ffmpeg_found": bool(ffmpeg),
            "ffmpeg_path": ffmpeg or "",
        }

    # -- 解析播放列表 -----------------------------------------------------

    @app.post("/api/probe")
    async def probe(request: "ProbeRequest") -> Dict[str, Any]:
        import asyncio

        try:
            url = validate_url(request.url)
            headers = parse_headers_text(request.headers)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        try:
            summary = await asyncio.to_thread(
                hc.probe_playlist, url,
                headers=headers,
                user_agent=request.user_agent,
                referer=request.referer,
                verify_ssl=request.verify_ssl,
            )
        except hc.HLSError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:  # pragma: no cover - 兜底
            raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")
        return {"ok": True, "summary": summary.as_dict()}

    # -- 创建下载任务 -----------------------------------------------------

    @app.post("/api/download")
    async def download(request: "DownloadRequest") -> Dict[str, Any]:
        try:
            url = validate_url(request.url)
            parse_headers_text(request.headers)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if request.end is not None and request.start is not None \
                and request.end <= request.start:
            raise HTTPException(status_code=400, detail="结束秒数必须大于开始秒数")
        try:
            out_path = resolve_output_path(
                request.output_dir, request.output_name, url, request.no_mp4
            )
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"输出路径无效：{exc}")

        job_id = time.strftime("%Y%m%d%H%M%S") + "-" + os.urandom(3).hex()
        params = request.model_dump() if hasattr(request, "model_dump") else request.dict()
        params["url"] = url
        job = Job(job_id, params, out_path)
        store.add(job)
        thread = threading.Thread(
            target=run_download_job, args=(job, request),
            name=f"hls-job-{job_id}", daemon=True,
        )
        job.thread = thread
        thread.start()
        job.add_log("info", f"任务已创建：{out_path}")
        return {
            "ok": True,
            "job_id": job_id,
            "output_path": str(out_path),
        }

    # -- 任务查询 / 操作 ---------------------------------------------------

    @app.get("/api/jobs")
    def list_jobs() -> Dict[str, Any]:
        return {"ok": True, "jobs": store.list_recent(limit=10)}

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str) -> Dict[str, Any]:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return {"ok": True, "job": job.snapshot()}

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str) -> Dict[str, Any]:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if job.state not in ("queued", "running"):
            return {"ok": False, "message": f"任务已结束（{job.state}）"}
        cancelled = job.request_cancel()
        return {"ok": True, "message": "已请求取消" if cancelled else "任务尚未开始，稍后自动取消"}

    @app.post("/api/jobs/{job_id}/open-folder")
    def job_open_folder(job_id: str) -> Dict[str, Any]:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if open_in_explorer(job.out_path):
            return {"ok": True}
        return {"ok": False, "message": "文件不存在或无法打开文件管理器"}

    # -- 关闭本地服务（仅用于本地自测/便捷退出） --------------------------

    @app.post("/api/shutdown")
    def shutdown() -> Dict[str, Any]:
        for job in store.running_jobs():
            job.request_cancel()
        server = getattr(app.state, "server", None)
        if server is not None:
            server.should_exit = True
        return {"ok": True, "message": "服务正在关闭"}

    return app


# ---------------------------------------------------------------------------
# 启动服务器
# ---------------------------------------------------------------------------


def pick_socket(host: str, start_port: int, tries: int = 20) -> tuple[socket.socket, int]:
    """绑定一个可用端口并返回 ``(已监听 socket, 端口)``。

    ``start_port=0`` 表示由系统随机分配。

    注意：Windows 上 ``SO_REUSEADDR`` 允许重复绑定同一端口，因此不能只依赖
    “带 SO_REUSEADDR 的 bind 是否成功”来判断端口占用——先用一个**不带**
    SO_REUSEADDR 的探测 socket 判断，再正式绑定并 listen，确保两个实例不会
    抢同一个端口。
    """
    last_error: Optional[OSError] = None
    if start_port == 0:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, 0))
            sock.listen(128)
        except OSError as exc:  # pragma: no cover - 极端环境
            sock.close()
            raise OSError(f"无法绑定随机端口：{exc}") from exc
        return sock, sock.getsockname()[1]

    for port in range(start_port, start_port + max(tries, 1)):
        # 1) 探测：不带 SO_REUSEADDR 的 bind 能发现已被监听/占用的端口
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind((host, port))
        except OSError as exc:
            last_error = exc
            probe.close()
            continue
        finally:
            try:
                probe.close()
            except OSError:
                pass
        # 2) 正式绑定并监听（SO_REUSEADDR 仅用于快速重启时绕过 TIME_WAIT）
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
            sock.listen(128)
        except OSError as exc:
            last_error = exc
            sock.close()
            continue
        return sock, sock.getsockname()[1]
    raise OSError(
        f"无法在 {host} 上找到可用端口（尝试了 {tries} 个）：{last_error}"
    )


def _open_browser_when_ready(url: str, server: Any, delay: float = 0.3) -> None:
    """等待 uvicorn 启动完成后自动打开浏览器。"""
    deadline = time.time() + 30.0
    while time.time() < deadline:
        if getattr(server, "started", False):
            time.sleep(delay)
            try:
                webbrowser.open(url)
            except Exception:
                pass
            return
        time.sleep(0.1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="app.py",
        description="HLS 视频下载器 · 本地网页版",
    )
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help=f"监听地址（默认 {DEFAULT_HOST}，建议保持只绑本机）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"起始端口（默认 {DEFAULT_PORT}，被占用时自动向后尝试；0 = 随机）")
    parser.add_argument("--port-tries", type=int, default=20,
                        help="端口被占用时最多向后尝试的个数（默认 20）")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--log-level", default="warning",
                        choices=["critical", "error", "warning", "info", "debug"],
                        help="uvicorn 日志级别（默认 warning）")
    parser.add_argument("--version", action="version", version=f"%(prog)s {hc.__version__}")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not HAS_WEB_DEPS:
        print("无法启动网页版：缺少 fastapi / uvicorn 依赖。", file=sys.stderr)
        print(f"  详细信息：{_WEB_DEPS_ERROR}", file=sys.stderr)
        print("  可改用命令行版：python hls_downloader.py <m3u8 链接>", file=sys.stderr)
        return 1

    if not (WEBUI_DIR / "index.html").is_file():
        print(f"错误：缺少网页文件 {WEBUI_DIR / 'index.html'}", file=sys.stderr)
        return 1

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"警告：你正在监听 {args.host}，同网段的其他设备可能访问到本工具。",
              file=sys.stderr)

    app = create_app()
    try:
        sock, port = pick_socket(args.host, args.port, args.port_tries)
    except OSError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    url = f"http://{args.host}:{port}/"
    print("=" * 66, flush=True)
    print("  HLS 视频下载器 · 本地网页版", flush=True)
    print(f"  版本：v{hc.__version__}    AES 后端：{hc.aes_backend_name()}", flush=True)
    print(f"  浏览器打开：{url}", flush=True)
    print("  （关闭本窗口或按 Ctrl+C 结束服务）", flush=True)
    print("=" * 66, flush=True)

    config = uvicorn.Config(
        app,
        host=args.host,
        port=port,
        log_level=args.log_level,
        access_log=False,
        lifespan="auto",
    )
    server = uvicorn.Server(config)
    app.state.server = server

    if not args.no_browser:
        threading.Thread(
            target=_open_browser_when_ready, args=(url, server),
            name="open-browser", daemon=True,
        ).start()

    exit_code = 0
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:  # pragma: no cover - 交互式退出
        exit_code = 130
    except Exception as exc:  # pragma: no cover - 兜底
        print(f"服务运行失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        exit_code = 1
    finally:
        for job in app.state.store.running_jobs():
            job.request_cancel()
        try:
            sock.close()
        except OSError:
            pass
        print("\n服务已关闭。", flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
