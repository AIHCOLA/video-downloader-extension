# -*- coding: utf-8 -*-
"""HLS 视频下载器 · 命令行入口

用法示例::

    # 下载整片（默认封装为 MP4，输出到工作区 downloads/）
    python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8"

    # 指定输出文件与并发
    python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8" \
        -o downloads/demo.mp4 --concurrency 48

    # 只下载第 0~20 秒（只下载覆盖该区间的片段，ffmpeg 精确裁剪到 20 秒）
    python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8" \
        --start 0 --end 20 -o _selftest/clip20.mp4

    # 只解析播放列表，不下载
    python hls_downloader.py "https://vv.jisuzyv.com/play/aQWNV05d/index.m3u8" --probe

    # 自定义请求头 / Referer / UA
    python hls_downloader.py URL --referer "https://example.com/" \
        --user-agent "Mozilla/5.0 ..." --headers "Cookie: a=b"
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
# 直接运行脚本时脚本目录通常已在 sys.path，这里再显式加一次，便于从别处调用
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import hls_core as hc  # noqa: E402  （必须在 sys.path 设置之后导入）


# ---------------------------------------------------------------------------
# 输出辅助
# ---------------------------------------------------------------------------


class ConsoleReporter:
    """命令行进度与日志输出。

    * 终端（TTY）：同一行刷新进度，日志另起一行；
    * 重定向/管道：按阶段变化与最多每 5 秒输出一行，避免刷屏。
    """

    def __init__(self, quiet: bool = False) -> None:
        self.quiet = quiet
        self.is_tty = bool(getattr(sys.stdout, "isatty", lambda: False)())
        self._last_phase: Optional[str] = None
        self._last_print = 0.0
        self._progress_dirty = False
        self._prev_len = 0
        self._last_percent = -1

    # -- 日志 -------------------------------------------------------------

    def log(self, level: str, message: str) -> None:
        if self.quiet and level == "info":
            return
        self._clear_progress()
        stamp = time.strftime("%H:%M:%S")
        prefix = {"warn": "警告", "error": "错误"}.get(level, "信息")
        line = f"[{stamp}] [{prefix}] {message}"
        print(line, flush=True)

    # -- 进度 -------------------------------------------------------------

    def _clear_progress(self) -> None:
        if self._progress_dirty:
            width = max(self._prev_len, 1)
            sys.stdout.write("\r" + " " * width + "\r")
            sys.stdout.flush()
            self._progress_dirty = False
            self._prev_len = 0

    def on_progress(self, info: hc.ProgressInfo) -> None:
        if self.quiet:
            return
        line = self._format(info)
        if self.is_tty:
            width = max(shutil.get_terminal_size((100, 20)).columns - 1, 20)
            padded = line[:width - 1].ljust(width - 1)
            sys.stdout.write("\r" + padded)
            sys.stdout.flush()
            self._progress_dirty = True
            self._prev_len = len(padded)
        else:
            now = time.monotonic()
            phase_changed = info.phase != self._last_phase
            enough_time = now - self._last_print >= 5.0
            big_step = int(info.percent // 10) != int(self._last_percent // 10)
            if phase_changed or (enough_time and big_step) or info.phase in ("done", "cancelled"):
                print(line, flush=True)
                self._last_print = now
        self._last_phase = info.phase
        self._last_percent = info.percent
        if info.phase in ("done", "cancelled"):
            self.finish()

    def finish(self) -> None:
        if self._progress_dirty:
            sys.stdout.write("\n")
            sys.stdout.flush()
            self._progress_dirty = False

    @staticmethod
    def _format(info: hc.ProgressInfo) -> str:
        label = info.phase_label
        if info.phase == "download":
            size_part = hc.format_bytes(info.downloaded_bytes)
            if info.total_bytes_estimate:
                size_part += "/" + hc.format_bytes(info.total_bytes_estimate)
            eta = f"剩余 {info.eta_text}" if info.eta_seconds is not None else ""
            seg = f"{info.segments_done}/{info.segments_total} 片段"
            return (f"[{label}] {info.percent:5.1f}%  {seg}  {size_part}  "
                    f"{hc.format_speed(info.speed_bps)}  {eta}").rstrip()
        if info.phase == "decrypt":
            seg = f"{info.segments_done}/{info.segments_total} 片段" \
                if info.segments_total else ""
            return f"[{label}] {info.percent:5.1f}%  {seg}".rstrip()
        return f"[{label}] {info.percent:5.1f}%  {info.message}".rstrip()


# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"需要整数，收到：{text!r}")
    if value <= 0:
        raise argparse.ArgumentTypeError("需要正整数")
    return value


def _non_negative_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"需要整数，收到：{text!r}")
    if value < 0:
        raise argparse.ArgumentTypeError("不能为负数")
    return value


def _seconds(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"需要秒数（数字），收到：{text!r}")
    if value < 0:
        raise argparse.ArgumentTypeError("秒数不能为负数")
    return value


def _parse_header_arg(raw: str) -> tuple[str, str]:
    if ":" not in raw:
        raise argparse.ArgumentTypeError(f"请求头格式应为 '名称: 值'，收到：{raw!r}")
    name, _, value = raw.partition(":")
    name, value = name.strip(), value.strip()
    if not name:
        raise argparse.ArgumentTypeError(f"请求头名称为空：{raw!r}")
    return name, value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hls_downloader.py",
        description="HLS(AES-128) 视频下载器：解析 m3u8 → 并发下载 → 解密拼接 → 封装 MP4",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python hls_downloader.py https://example.com/play/id/index.m3u8\n"
            "  python hls_downloader.py URL --start 0 --end 20 -o clip.mp4\n"
            "  python hls_downloader.py URL --probe\n"
            "  python hls_downloader.py URL --no-mp4 --keep-ts -o output.ts\n"
        ),
    )
    parser.add_argument("url", help="m3u8 播放列表地址（媒体列表或 master 列表均可）")
    parser.add_argument("-o", "--output", help="输出文件路径；缺省为 <输出目录>/<自动命名>.mp4")
    parser.add_argument("--output-dir", help="输出目录；缺省为工作区 downloads/ 目录")
    parser.add_argument("--headers", action="append", default=[], metavar="'名称: 值'",
                        help="附加请求头，可重复，例如 --headers 'Cookie: a=b'")
    parser.add_argument("--referer", help="自定义 Referer（缺省按播放列表地址推导为站根目录）")
    parser.add_argument("--user-agent", help="自定义 User-Agent")
    parser.add_argument("--concurrency", type=_positive_int, default=hc.DEFAULT_CONCURRENCY,
                        metavar=f"{hc.MIN_CONCURRENCY}~{hc.MAX_CONCURRENCY}",
                        help=f"并发下载数（默认 {hc.DEFAULT_CONCURRENCY}，建议 8~64）")
    parser.add_argument("--start", type=_seconds, metavar="秒",
                        help="只下载从该秒开始的片段（按百分比裁剪，MP4 会精确裁剪）")
    parser.add_argument("--end", type=_seconds, metavar="秒",
                        help="只下载到该秒为止的片段（与 --start 搭配可截取短片段）")
    parser.add_argument("--retries", type=_non_negative_int, default=hc.DEFAULT_RETRIES,
                        help=f"单个片段失败重试次数（默认 {hc.DEFAULT_RETRIES}，0 表示不重试）")
    parser.add_argument("--keep-ts", action="store_true",
                        help="保留解密拼接后的 TS 文件（与 MP4 同目录）")
    parser.add_argument("--no-mp4", action="store_true",
                        help="不调用 ffmpeg 封装，直接输出解密后的 TS 文件")
    parser.add_argument("--verify-ssl", action="store_true",
                        help="严格校验 HTTPS 证书（默认关闭；该环境的证书链校验通常失败）")
    parser.add_argument("--probe", action="store_true",
                        help="只解析播放列表并输出信息，不下载片段")
    parser.add_argument("-q", "--quiet", action="store_true", help="只输出错误与最终结果")
    parser.add_argument("-v", "--verbose", action="store_true", help="输出更多调试信息")
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s {hc.__version__}（AES 后端：{hc.aes_backend_name()}）")
    return parser


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _resolve_output(args: argparse.Namespace) -> Path:
    """确定输出文件路径。"""
    if args.output:
        path = Path(args.output).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        return path
    if args.output_dir:
        out_dir = Path(args.output_dir).expanduser()
        if not out_dir.is_absolute():
            out_dir = Path.cwd() / out_dir
    else:
        out_dir = hc.default_output_dir()
    ext = ".ts" if args.no_mp4 else ".mp4"
    name = hc.default_output_name(args.url, ext)
    return hc.unique_path(out_dir / name)


def _print_banner(args: argparse.Namespace, output: Path, headers: Dict[str, str]) -> None:
    print("=" * 70)
    print(f"HLS 视频下载器 v{hc.__version__}")
    print(f"目标链接：{args.url}")
    print(f"输出文件：{output}")
    print(f"并发数  ：{args.concurrency}    重试：{args.retries}    "
          f"封装：{'直接输出 TS' if args.no_mp4 else 'ffmpeg 封装 MP4'}")
    print(f"Referer ：{headers.get('Referer') or '(未设置)'}")
    print(f"UA      ：{headers.get('User-Agent', '')[:80]}")
    if args.start is not None or args.end is not None:
        print(f"裁剪区间：{args.start or 0:.2f}s ~ "
              f"{args.end if args.end is not None else '结尾'}")
    ffmpeg = hc.find_ffmpeg()
    print(f"ffmpeg  ：{ffmpeg or '(未找到，将只能输出 TS)'}")
    print(f"AES 后端：{hc.aes_backend_name()}"
          + ("" if hc.HAS_PYCRYPTODOME else "（未找到 pycryptodome，使用较慢的纯 Python 实现）"))
    if args.verify_ssl:
        print("SSL     ：严格校验证书")
    print("=" * 70)


def run(args: argparse.Namespace) -> int:
    headers: Dict[str, str] = {}
    for raw in args.headers:
        try:
            name, value = _parse_header_arg(raw)
        except argparse.ArgumentTypeError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        headers[name] = value

    reporter = ConsoleReporter(quiet=args.quiet)

    if args.end is not None and args.start is not None and args.end <= args.start:
        print(f"错误：--end（{args.end}）必须大于 --start（{args.start}）", file=sys.stderr)
        return 2
    if args.concurrency > hc.MAX_CONCURRENCY:
        print(f"错误：--concurrency 最大 {hc.MAX_CONCURRENCY}（收到 {args.concurrency}）",
              file=sys.stderr)
        return 2

    # 只探测播放列表
    if args.probe:
        try:
            summary = hc.probe_playlist(
                args.url, headers=headers, user_agent=args.user_agent,
                referer=args.referer, verify_ssl=args.verify_ssl,
                on_log=reporter.log,
            )
        except ValueError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        except hc.HLSError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            return 130
        print("-" * 70)
        print(summary.describe())
        print("-" * 70)
        return 0

    output = _resolve_output(args)
    try:
        downloader = hc.HLSDownloader(
            args.url,
            headers=headers,
            user_agent=args.user_agent,
            referer=args.referer,
            concurrency=args.concurrency,
            retries=args.retries,
            verify_ssl=args.verify_ssl,
            on_progress=reporter.on_progress,
            on_log=reporter.log,
        )
    except (ValueError, hc.HLSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    _print_banner(args, output, downloader.headers)

    started = time.monotonic()
    try:
        result = downloader.download(
            output,
            start=args.start,
            end=args.end,
            keep_ts=args.keep_ts,
            no_mp4=args.no_mp4,
        )
    except KeyboardInterrupt:
        downloader.cancel()
        reporter.finish()
        print("\n已取消（Ctrl+C）")
        return 130
    except hc.DownloadCancelled:
        reporter.finish()
        print("\n已取消下载。")
        return 130
    except hc.FFmpegError as exc:
        reporter.finish()
        print(f"\n[失败] {exc}", file=sys.stderr)
        return 3
    except hc.HLSError as exc:
        reporter.finish()
        print(f"\n[失败] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # 兜底：避免直接抛 traceback 吓到用户
        reporter.finish()
        print(f"\n[失败] 未预期的错误：{type(exc).__name__}: {exc}", file=sys.stderr)
        if args.verbose:
            import traceback

            traceback.print_exc()
        return 1

    reporter.finish()
    print()
    print(result.summary())
    print(f"总耗时：{time.monotonic() - started:.1f} 秒")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
