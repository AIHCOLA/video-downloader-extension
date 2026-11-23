# -*- coding: utf-8 -*-
"""HLS 下载核心模块（可复用）

本模块是「HLS 视频下载器」的核心，提供：解析 m3u8 / AES-128 解密 / 并发下载 /
按序拼接 / ffmpeg 无重编码封装 MP4 / 进度与日志回调 / 取消支持。命令行
(``hls_downloader.py``) 与网页版 (``app.py``) 都复用它。

主要能力
--------
* 解析媒体播放列表与 master 播放列表（master 自动选最高码率）
* 支持 ``EXT-X-KEY`` AES-128：显式 IV，缺省 IV = 媒体序号；支持密钥轮换
* aiohttp 并发下载（1~128 并发，默认 32），失败指数退避重试
* 按顺序解密拼接为 TS，再调用 ffmpeg ``-c copy`` 封装为 MP4
* ``start`` / ``end`` 按秒裁剪，只下载覆盖该区间的片段
* 进度回调 ``ProgressInfo``、日志回调、线程安全取消
* 仅依赖 aiohttp / pycryptodome / 标准库；缺少 pycryptodome 时回退到内置
  纯 Python AES-128 实现（可用但较慢，适合短视频）
* 自动定位工作区 ``_tools`` 目录（嵌入式 Python 会忽略 PYTHONPATH）
* 自动定位 ffmpeg：环境变量 ``HLS_FFMPEG`` > ``_tools/imageio_ffmpeg`` > PATH

快速使用::

    from hls_core import HLSDownloader

    def on_progress(info):
        print(info.phase_label, f"{info.percent:.1f}%")

    dl = HLSDownloader("https://example.com/play/id/index.m3u8", concurrency=32,
                       on_progress=on_progress)
    result = dl.download("downloads/demo.mp4")
    print(result.summary())

命令与回调均可能发生于工作线程；回调里请避免长时间阻塞操作。
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union
from urllib.parse import unquote, urljoin, urlparse

__version__ = "1.0.0"

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

DEFAULT_CONCURRENCY = 32
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 128

DEFAULT_RETRIES = 4
DEFAULT_CONNECT_TIMEOUT = 15.0
DEFAULT_READ_TIMEOUT = 60.0
DEFAULT_TOTAL_TIMEOUT = 120.0

#: 附带 ``-tls_verify 0`` 等参数时仅供参考；本模块下载走 aiohttp，不经过 ffmpeg。
TLS_HINT = "该站点 HTTPS 证书链校验可能失败，默认 verify_ssl=False；如需严格校验请加 --verify-ssl"

_CONCURRENCY_ERROR = f"并发数必须在 {MIN_CONCURRENCY}~{MAX_CONCURRENCY} 之间"

# 支持解密的 AES 密钥长度（AES-128/192/256，HLS 标准为 AES-128）
_AES_KEY_LENGTHS = (16, 24, 32)


# ---------------------------------------------------------------------------
# 路径与依赖自动定位
# ---------------------------------------------------------------------------


def _search_roots() -> List[Path]:
    """返回可能包含 ``_tools`` 的候选根目录（脚本目录、工作目录及其祖先）。"""
    roots: List[Path] = []

    def _add(p: Path) -> None:
        try:
            rp = p.resolve()
        except OSError:
            return
        if rp not in roots:
            roots.append(rp)

    here = Path(__file__).resolve().parent
    _add(here)
    for parent in here.parents:
        _add(parent)
    try:
        cwd = Path.cwd()
        _add(cwd)
        for parent in cwd.parents:
            _add(parent)
    except OSError:  # pragma: no cover - 极端环境
        pass
    return roots


def ensure_tools_on_path() -> Optional[str]:
    """把工作区 ``_tools`` 目录加入 ``sys.path``，返回加入的目录。

    嵌入式 Python 带 ``python312._pth`` 时会忽略 ``PYTHONPATH``，所以第三方包
    （pycryptodome、imageio-ffmpeg）必须由脚本自己插入搜索路径。
    已可导入 pycryptodome 时返回 ``None``。
    """
    try:  # 已装到解释器里则无需处理
        import Crypto  # noqa: F401
    except Exception:
        pass
    else:
        return None

    candidates: List[Path] = []
    env = os.environ.get("HLS_TOOLS_DIR")
    if env:
        candidates.append(Path(env))
    for root in _search_roots():
        candidates.append(root / "_tools")

    for cand in candidates:
        try:
            if cand.is_dir() and (cand / "Crypto").is_dir():
                sp = str(cand)
                if sp not in sys.path:
                    sys.path.insert(0, sp)
                return sp
        except OSError:
            continue
    return None


_TOOLS_DIR = ensure_tools_on_path()

try:  # pycryptodome 缺失时回退到内置纯 Python AES
    from Crypto.Cipher import AES as _CryptoAES

    HAS_PYCRYPTODOME = True
except Exception:  # pragma: no cover - 依赖缺失时才触发
    _CryptoAES = None  # type: ignore[assignment]
    HAS_PYCRYPTODOME = False

try:  # aiohttp 是唯一的网络依赖
    import aiohttp

    HAS_AIOHTTP = True
    _AIOHTTP_ERROR: Optional[BaseException] = None
except Exception as _aiohttp_exc:  # pragma: no cover - 依赖缺失时才触发
    aiohttp = None  # type: ignore[assignment]
    HAS_AIOHTTP = False
    _AIOHTTP_ERROR = _aiohttp_exc


@functools.lru_cache(maxsize=1)
def find_ffmpeg() -> Optional[str]:
    """定位 ffmpeg 可执行文件；找不到返回 ``None``。

    查找顺序：环境变量 ``HLS_FFMPEG`` → 各候选根目录下的
    ``_tools/imageio_ffmpeg/binaries/ffmpeg*.exe``（新版本优先）→
    ``imageio_ffmpeg.get_ffmpeg_exe()`` → ``PATH`` 中的 ``ffmpeg``。
    """
    env = os.environ.get("HLS_FFMPEG")
    if env and Path(env).is_file():
        return str(Path(env))

    binaries: List[Path] = []
    for root in _search_roots():
        base = root / "_tools" / "imageio_ffmpeg" / "binaries"
        try:
            if base.is_dir():
                binaries.extend(sorted(base.glob("ffmpeg*")))
        except OSError:
            continue
    # 优先选择 .exe，且版本号大的优先
    exes = [p for p in binaries if p.is_file() and p.suffix.lower() == ".exe"]
    if not exes:
        exes = [p for p in binaries if p.is_file() and p.suffix.lower() not in (".dll", ".pyd")]
    if exes:
        def _version_key(p: Path) -> Tuple[int, ...]:
            nums = re.findall(r"(\d+)", p.stem)
            return tuple(int(n) for n in nums[:4]) or (0,)

        return str(max(exes, key=_version_key))

    try:  # imageio-ffmpeg 已安装时可询问它
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).is_file():
            return str(exe)
    except Exception:
        pass

    found = shutil.which("ffmpeg")
    return found


def workspace_root() -> Path:
    """猜测工作区根目录：最近的包含 ``_tools`` 或 ``downloads`` 的祖先目录。"""
    here = Path(__file__).resolve().parent
    for cand in (here, *here.parents):
        try:
            if (cand / "_tools").is_dir() or (cand / "downloads").is_dir():
                return cand
        except OSError:
            continue
    return here


def default_output_dir() -> Path:
    """默认输出目录：工作区 ``downloads/``（不存在时返回该路径，由调用方创建）。"""
    return workspace_root() / "downloads"


def default_output_name(url: str, ext: str = ".mp4") -> str:
    """由播放列表 URL 推导一个可读的默认文件名，例如 ``aQWNV05d.mp4``。"""
    try:
        path = urlparse(url).path or ""
    except ValueError:
        path = ""
    parts = [unquote(p) for p in path.split("/") if p]
    # 去掉常见的索引文件名（index.m3u8 / master.m3u8 …）和通用目录名
    generic = {
        "play", "plays", "hls", "vod", "video", "videos", "live", "stream",
        "streams", "media", "index", "master", "main", "tv", "drama", "api",
    }
    cleaned = [
        p for p in parts
        if not re.fullmatch(r"(index|playlist|main|master|media|manifest)\.(m3u8?|txt)", p, re.I)
    ]
    meaningful = [p for p in cleaned if p.lower() not in generic]
    if meaningful:
        stem = meaningful[-1]
    elif cleaned:
        stem = cleaned[-1]
    elif parts:
        stem = parts[-1]
    else:
        stem = ""
    if stem.lower().endswith((".m3u8", ".m3u")):
        stem = stem.rsplit(".", 1)[0]
    stem = re.sub(r'[\\/:*?"<>|\s]+', "_", stem).strip("._") or "hls_video"
    if len(stem) > 80:
        stem = stem[:80].rstrip("._")
    return stem if stem.lower().endswith(ext.lower()) else stem + ext


def unique_path(path: Union[str, Path]) -> Path:
    """若目标文件已存在，追加 ``_2``、``_3`` … 直到不冲突。"""
    p = Path(path)
    if not p.exists():
        return p
    stem, suffix, parent = p.stem, p.suffix, p.parent
    i = 2
    while True:
        cand = parent / f"{stem}_{i}{suffix}"
        if not cand.exists():
            return cand
        i += 1


def format_bytes(num: Optional[float]) -> str:
    """把字节数格式化为人类可读字符串。"""
    if num is None or num < 0:
        return "-"
    n = float(num)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} TB"  # pragma: no cover - 理论不可达


def format_duration(seconds: Optional[float]) -> str:
    """把秒数格式化为 ``HH:MM:SS`` / ``MM:SS``。"""
    if seconds is None or seconds < 0 or seconds == float("inf"):
        return "--:--"
    total = int(round(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def format_speed(bytes_per_second: Optional[float]) -> str:
    """把字节/秒格式化为 ``x.x MB/s``。"""
    if not bytes_per_second or bytes_per_second < 0:
        return "-"
    return f"{bytes_per_second / 1048576.0:.2f} MB/s"


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------


class HLSError(Exception):
    """本模块所有异常的基类。"""


class PlaylistError(HLSError):
    """播放列表获取或解析失败。"""


class DownloadError(HLSError):
    """片段/密钥下载失败。"""


class UnsupportedError(HLSError):
    """遇到不支持的特性（如 SAMPLE-AES、非 identity KEYFORMAT）。"""


class DownloadCancelled(HLSError):
    """用户取消下载。"""


class FFmpegError(HLSError):
    """ffmpeg 封装失败，或找不到 ffmpeg。"""


# ---------------------------------------------------------------------------
# AES-128 解密（pycryptodome 优先，缺失时使用内置纯 Python 实现）
# ---------------------------------------------------------------------------


def _gf_mul(a: int, b: int) -> int:
    """GF(2^8) 乘法（AES 多项式 0x11B）。"""
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


@functools.lru_cache(maxsize=1)
def _aes_tables() -> Tuple[bytes, bytes]:
    """生成 AES S 盒与逆 S 盒（按定义计算，避免手抄大表出错）。"""
    inverse = [0] * 256
    for a in range(1, 256):
        for b in range(1, 256):
            if _gf_mul(a, b) == 1:
                inverse[a] = b
                break
    sbox = [0] * 256
    for a in range(256):
        x = inverse[a]
        out = 0
        for i in range(8):
            bit = (
                ((x >> i) & 1)
                ^ ((x >> ((i + 4) % 8)) & 1)
                ^ ((x >> ((i + 5) % 8)) & 1)
                ^ ((x >> ((i + 6) % 8)) & 1)
                ^ ((x >> ((i + 7) % 8)) & 1)
                ^ ((0x63 >> i) & 1)
            )
            out |= bit << i
        sbox[a] = out
    inv_sbox = [0] * 256
    for i, v in enumerate(sbox):
        inv_sbox[v] = i
    return bytes(sbox), bytes(inv_sbox)


def _expand_aes_key(key: bytes) -> List[bytes]:
    """AES 密钥扩展，返回各轮 16 字节轮密钥。"""
    sbox, _ = _aes_tables()
    nk = len(key) // 4
    nr = nk + 6
    words: List[List[int]] = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    rcon = 1
    for i in range(nk, 4 * (nr + 1)):
        temp = words[i - 1][:]
        if i % nk == 0:
            temp = temp[1:] + temp[:1]
            temp = [sbox[b] for b in temp]
            temp[0] ^= rcon
            rcon = _gf_mul(rcon, 2)
        words.append([words[i - nk][j] ^ temp[j] for j in range(4)])
    return [bytes(b for w in words[4 * r:4 * r + 4] for b in w) for r in range(nr + 1)]


def _add_round_key(state: List[List[int]], rk: bytes, offset: int) -> None:
    for c in range(4):
        for r in range(4):
            state[r][c] ^= rk[offset + 4 * c + r]


def _inv_shift_rows(state: List[List[int]]) -> List[List[int]]:
    return [state[r][-r:] + state[r][:-r] for r in range(4)]


def _inv_mix_columns(state: List[List[int]]) -> List[List[int]]:
    matrix = ((14, 11, 13, 9), (9, 14, 11, 13), (13, 9, 14, 11), (11, 13, 9, 14))
    out = [[0] * 4 for _ in range(4)]
    for c in range(4):
        col = [state[r][c] for r in range(4)]
        for r in range(4):
            out[r][c] = (
                _gf_mul(col[0], matrix[r][0])
                ^ _gf_mul(col[1], matrix[r][1])
                ^ _gf_mul(col[2], matrix[r][2])
                ^ _gf_mul(col[3], matrix[r][3])
            )
    return out


def _py_aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    """纯 Python AES-CBC 解密（仅在 pycryptodome 缺失时使用）。"""
    if not data:
        return b""
    if len(data) % 16:
        raise HLSError(f"密文长度不是 16 的倍数：{len(data)}")
    sbox, inv_sbox = _aes_tables()
    round_keys = _expand_aes_key(key)
    nr = len(round_keys) - 1
    out = bytearray()
    prev = iv
    for pos in range(0, len(data), 16):
        block = data[pos:pos + 16]
        state = [list(block[r::4]) for r in range(4)]
        _add_round_key(state, round_keys[nr], 0)
        for rnd in range(nr - 1, 0, -1):
            state = _inv_shift_rows(state)
            state = [[inv_sbox[b] for b in row] for row in state]
            _add_round_key(state, round_keys[rnd], 0)
            state = _inv_mix_columns(state)
        state = _inv_shift_rows(state)
        state = [[inv_sbox[b] for b in row] for row in state]
        _add_round_key(state, round_keys[0], 0)
        plain = bytes(state[r][c] for c in range(4) for r in range(4))
        out.extend(bytes(a ^ b for a, b in zip(plain, prev)))
        prev = block
    return bytes(out)


def _pkcs7_unpad(data: bytes) -> bytes:
    """去除 PKCS#7 填充；填充不合法时原样返回（宽容处理异常流）。"""
    if not data:
        return data
    pad = data[-1]
    if 1 <= pad <= 16 and len(data) >= pad and data[-pad:] == bytes([pad]) * pad:
        return data[:-pad]
    return data


def decrypt_segment(data: bytes, key: Optional[bytes], iv: Optional[bytes]) -> bytes:
    """解密一个 AES-128 加密的媒体片段（PKCS#7 填充）。``key`` 为 None 时原样返回。"""
    if not key:
        return data
    if iv is None:
        iv = b"\x00" * 16
    iv = iv[-16:].rjust(16, b"\x00")
    if len(data) % 16:
        raise HLSError(f"加密片段长度不是 16 的倍数：{len(data)}（可能不是完整 AES-128 片段）")
    if HAS_PYCRYPTODOME:
        raw = _CryptoAES.new(key, _CryptoAES.MODE_CBC, iv).decrypt(data)
    else:
        raw = _py_aes_cbc_decrypt(key, iv, data)
    return _pkcs7_unpad(raw)


def aes_backend_name() -> str:
    """当前 AES 后端名称。"""
    return "pycryptodome" if HAS_PYCRYPTODOME else "pure-python"


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------


@dataclass
class KeyInfo:
    """``EXT-X-KEY`` 描述。"""

    method: str = "NONE"
    uri: Optional[str] = None
    iv: Optional[bytes] = None
    keyformat: str = "identity"

    def describe(self) -> str:
        if self.method.upper() == "NONE":
            return "未加密"
        iv_hex = self.iv.hex() if self.iv is not None else "默认(媒体序号)"
        return f"{self.method} (IV={iv_hex})"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "uri": self.uri,
            "iv": self.iv.hex() if self.iv is not None else None,
            "keyformat": self.keyformat,
        }


@dataclass
class ByteRange:
    """``EXT-X-BYTERANGE``。"""

    length: int
    offset: int = 0

    @property
    def end(self) -> int:
        return self.offset + self.length - 1

    def header_value(self) -> str:
        return f"bytes={self.offset}-{self.end}"


@dataclass
class Segment:
    """媒体播放列表中的一个片段。"""

    index: int
    url: str
    duration: float = 0.0
    sequence: int = 0
    key: Optional[KeyInfo] = None
    byterange: Optional[ByteRange] = None
    map_uri: Optional[str] = None
    map_byterange: Optional[ByteRange] = None

    @property
    def iv(self) -> bytes:
        """该片段的初始向量：显式 IV 优先，否则用媒体序号（16 字节大端）。"""
        if self.key is not None and self.key.iv is not None:
            return self.key.iv
        return int(self.sequence).to_bytes(16, "big")


@dataclass
class Variant:
    """master 播放列表中的一个码率变体。"""

    url: str
    bandwidth: int = 0
    resolution: Optional[str] = None
    codecs: Optional[str] = None
    frame_rate: Optional[float] = None
    name: Optional[str] = None

    @property
    def pixels(self) -> int:
        if not self.resolution:
            return 0
        m = re.match(r"(\d+)\s*[xX]\s*(\d+)", self.resolution)
        return int(m.group(1)) * int(m.group(2)) if m else 0

    def describe(self) -> str:
        bits = []
        if self.bandwidth:
            bits.append(f"{self.bandwidth // 1000} kbps")
        if self.resolution:
            bits.append(self.resolution)
        if self.codecs:
            bits.append(self.codecs)
        return " · ".join(bits) or self.url


@dataclass
class MasterPlaylist:
    """master（多码率）播放列表。"""

    url: str
    variants: List[Variant] = field(default_factory=list)
    version: Optional[int] = None

    is_master = True

    def best_variant(self) -> Variant:
        """选择码率最高的变体（码率相同则分辨率高的优先）。"""
        if not self.variants:
            raise PlaylistError("master 播放列表里没有可用的变体")
        return max(self.variants, key=lambda v: (v.bandwidth, v.pixels))


@dataclass
class MediaPlaylist:
    """媒体（片段）播放列表。"""

    url: str
    segments: List[Segment] = field(default_factory=list)
    media_sequence: int = 0
    target_duration: float = 0.0
    version: Optional[int] = None
    has_endlist: bool = False
    playlist_type: Optional[str] = None

    is_master = False

    @property
    def total_duration(self) -> float:
        return sum(s.duration for s in self.segments)

    @property
    def is_encrypted(self) -> bool:
        return any(s.key is not None and s.key.method.upper() != "NONE" for s in self.segments)

    def encryption_methods(self) -> List[str]:
        methods = []
        for seg in self.segments:
            if seg.key and seg.key.method.upper() != "NONE":
                if seg.key.method not in methods:
                    methods.append(seg.key.method)
        return methods

    def key_table(self) -> List[Dict[str, Any]]:
        seen = set()
        table = []
        for seg in self.segments:
            if seg.key and seg.key.method.upper() != "NONE" and seg.key.uri:
                if seg.key.uri not in seen:
                    seen.add(seg.key.uri)
                    table.append(seg.key.as_dict())
        return table


@dataclass
class PlaylistSummary:
    """播放列表探测结果（不下载）。"""

    url: str
    is_master: bool = False
    final_url: str = ""
    variants: List[Variant] = field(default_factory=list)
    segments: int = 0
    duration_seconds: float = 0.0
    target_duration: float = 0.0
    encrypted: bool = False
    encryption_methods: List[str] = field(default_factory=list)
    is_live: bool = False
    version: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "final_url": self.final_url,
            "is_master": self.is_master,
            "segments": self.segments,
            "duration_seconds": round(self.duration_seconds, 3),
            "duration_text": format_duration(self.duration_seconds),
            "target_duration": self.target_duration,
            "encrypted": self.encrypted,
            "encryption_methods": self.encryption_methods,
            "is_live": self.is_live,
            "version": self.version,
            "variants": [
                {
                    "url": v.url,
                    "bandwidth": v.bandwidth,
                    "resolution": v.resolution,
                    "codecs": v.codecs,
                    "describe": v.describe(),
                }
                for v in self.variants
            ],
        }

    def describe(self) -> str:
        lines = [f"播放列表：{self.final_url or self.url}"]
        if self.is_master:
            lines.append(f"类型：master（{len(self.variants)} 个码率变体，下载时自动选最高码率）")
            for v in sorted(self.variants, key=lambda v: v.bandwidth, reverse=True):
                lines.append(f"  - {v.describe()}")
        else:
            lines.append("类型：媒体播放列表")
        lines.append(f"片段数：{self.segments}")
        lines.append(f"总时长：{format_duration(self.duration_seconds)}"
                     f"（{self.duration_seconds:.1f} 秒）")
        if self.encrypted:
            lines.append(f"加密：{', '.join(self.encryption_methods)}（下载后自动解密）")
        else:
            lines.append("加密：未加密")
        if not self.is_master and self.is_live:
            lines.append("提示：未发现 EXT-X-ENDLIST，可能是直播列表，只能取到当前片段")
        return "\n".join(lines)


PHASE_LABELS = {
    "init": "初始化",
    "fetch_playlist": "解析播放列表",
    "fetch_key": "获取密钥",
    "download": "下载片段",
    "decrypt": "解密拼接",
    "mux": "封装 MP4",
    "probe": "校验输出",
    "done": "已完成",
    "error": "失败",
    "cancelled": "已取消",
}


@dataclass
class ProgressInfo:
    """一次进度快照（进度回调的参数）。"""

    phase: str = "init"
    message: str = ""
    percent: float = 0.0
    segments_done: int = 0
    segments_total: int = 0
    downloaded_bytes: int = 0
    total_bytes_estimate: Optional[int] = None
    speed_bps: float = 0.0
    eta_seconds: Optional[float] = None
    elapsed_seconds: float = 0.0
    output_path: Optional[str] = None

    @property
    def phase_label(self) -> str:
        return PHASE_LABELS.get(self.phase, self.phase)

    @property
    def speed_text(self) -> str:
        return format_speed(self.speed_bps)

    @property
    def eta_text(self) -> str:
        return format_duration(self.eta_seconds)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "phase": self.phase,
            "phase_label": self.phase_label,
            "message": self.message,
            "percent": round(self.percent, 2),
            "segments_done": self.segments_done,
            "segments_total": self.segments_total,
            "downloaded_bytes": self.downloaded_bytes,
            "downloaded_text": format_bytes(self.downloaded_bytes),
            "total_bytes_estimate": self.total_bytes_estimate,
            "total_bytes_estimate_text": format_bytes(self.total_bytes_estimate),
            "speed_bps": round(self.speed_bps, 1),
            "speed_text": self.speed_text,
            "eta_seconds": None if self.eta_seconds is None else round(self.eta_seconds, 1),
            "eta_text": self.eta_text,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "output_path": self.output_path,
        }


@dataclass
class DownloadResult:
    """下载完成后的结果信息。"""

    output_path: str
    ts_path: Optional[str] = None
    size_bytes: int = 0
    duration_seconds: float = 0.0
    clip_seconds: float = 0.0
    segments_downloaded: int = 0
    bytes_downloaded: int = 0
    elapsed_seconds: float = 0.0
    muxed: bool = False
    playlist_duration: float = 0.0
    video_streams: List[str] = field(default_factory=list)
    audio_streams: List[str] = field(default_factory=list)
    aes_backend: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "output_path": self.output_path,
            "ts_path": self.ts_path,
            "size_bytes": self.size_bytes,
            "size_text": format_bytes(self.size_bytes),
            "duration_seconds": round(self.duration_seconds, 3),
            "duration_text": format_duration(self.duration_seconds),
            "clip_seconds": round(self.clip_seconds, 3),
            "segments_downloaded": self.segments_downloaded,
            "bytes_downloaded": self.bytes_downloaded,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "muxed": self.muxed,
            "playlist_duration": round(self.playlist_duration, 3),
            "video_streams": self.video_streams,
            "audio_streams": self.audio_streams,
            "aes_backend": self.aes_backend,
        }

    def summary(self) -> str:
        lines = [
            "下载完成",
            f"  输出文件：{self.output_path}",
            f"  文件大小：{format_bytes(self.size_bytes)}（{self.size_bytes} 字节）",
            f"  视频时长：{format_duration(self.duration_seconds)}（{self.duration_seconds:.2f} 秒）",
        ]
        if self.clip_seconds and abs(self.clip_seconds - self.duration_seconds) > 1.5:
            lines.append(f"  片段区间：{self.clip_seconds:.2f} 秒")
        lines.append(f"  片段数量：{self.segments_downloaded}")
        lines.append(f"  下载流量：{format_bytes(self.bytes_downloaded)}")
        lines.append(f"  总耗时：{self.elapsed_seconds:.1f} 秒")
        lines.append(f"  封装方式：{'ffmpeg -c copy 封装 MP4' if self.muxed else '原始 TS 直出'}")
        lines.append(f"  AES 后端：{self.aes_backend}")
        if self.video_streams:
            lines.append(f"  视频流：{'; '.join(self.video_streams)}")
        if self.audio_streams:
            lines.append(f"  音频流：{'; '.join(self.audio_streams)}")
        if self.ts_path:
            lines.append(f"  保留 TS：{self.ts_path}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# m3u8 解析
# ---------------------------------------------------------------------------


def _parse_attributes(text: str) -> Dict[str, str]:
    """解析 HLS 标签属性串，例如 ``METHOD=AES-128,URI="k.key",IV=0x00..``。"""
    attrs: Dict[str, str] = {}
    for match in re.finditer(r'([A-Za-z0-9-]+)=("[^"]*"|[^,]*)', text):
        key = match.group(1).upper()
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        attrs[key] = value
    return attrs


def _parse_iv(text: str) -> Optional[bytes]:
    """解析 ``IV=0x...`` 为 16 字节。"""
    text = text.strip()
    if not text:
        return None
    if text.lower().startswith("0x"):
        text = text[2:]
    text = re.sub(r"[^0-9A-Fa-f]", "", text)
    if not text:
        return None
    if len(text) % 2:
        text = "0" + text
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        return None
    return raw[-16:].rjust(16, b"\x00")


def _parse_byterange(text: str) -> Optional[ByteRange]:
    """解析 ``延长@偏移`` 形式的 BYTERANGE。"""
    text = text.strip()
    if not text:
        return None
    m = re.match(r"(\d+)(?:@(\d+))?", text)
    if not m:
        return None
    return ByteRange(length=int(m.group(1)), offset=int(m.group(2) or 0))


def parse_m3u8(text: str, base_url: str) -> Union[MasterPlaylist, MediaPlaylist]:
    """解析 m3u8 文本，返回 :class:`MasterPlaylist` 或 :class:`MediaPlaylist`。

    ``base_url`` 用于把相对路径（片段、密钥、变体地址）解析成绝对地址。
    """
    if text is None:
        raise PlaylistError("播放列表内容为空")
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    stripped = [ln.strip() for ln in lines]
    first = next((ln for ln in stripped if ln), "")
    if not first.startswith("#EXTM3U"):
        raise PlaylistError("不是合法的 m3u8 文件（缺少 #EXTM3U 头）")

    variants: List[Variant] = []
    segments: List[Segment] = []
    version: Optional[int] = None
    media_sequence = 0
    target_duration = 0.0
    has_endlist = False
    playlist_type: Optional[str] = None

    current_key: Optional[KeyInfo] = None
    current_map_uri: Optional[str] = None
    current_map_range: Optional[ByteRange] = None
    pending_duration: Optional[float] = None
    pending_stream: Optional[Dict[str, str]] = None
    pending_byterange: Optional[str] = None
    # 延迟解析的 BYTERANGE 需要「上一次同 URL 的结束位置」做隐式偏移
    last_range: Dict[str, int] = {}
    index = 0

    for line in stripped:
        if not line:
            continue
        if line.startswith("#"):
            tag, _, value = line.partition(":")
            tag = tag.upper()
            if tag == "#EXT-X-VERSION":
                try:
                    version = int(value.strip())
                except ValueError:
                    pass
            elif tag == "#EXT-X-TARGETDURATION":
                try:
                    target_duration = float(value.strip())
                except ValueError:
                    pass
            elif tag == "#EXT-X-MEDIA-SEQUENCE":
                try:
                    media_sequence = int(value.strip())
                except ValueError:
                    pass
            elif tag == "#EXT-X-ENDLIST":
                has_endlist = True
            elif tag == "#EXT-X-PLAYLIST-TYPE":
                playlist_type = value.strip().upper() or None
            elif tag == "#EXT-X-KEY":
                attrs = _parse_attributes(value)
                method = attrs.get("METHOD", "NONE").upper()
                uri = attrs.get("URI")
                keyformat = attrs.get("KEYFORMAT", "identity") or "identity"
                if method == "NONE":
                    current_key = None
                else:
                    current_key = KeyInfo(
                        method=method,
                        uri=urljoin(base_url, uri) if uri else None,
                        iv=_parse_iv(attrs.get("IV", "")),
                        keyformat=keyformat,
                    )
            elif tag == "#EXT-X-MAP":
                attrs = _parse_attributes(value)
                uri = attrs.get("URI")
                current_map_uri = urljoin(base_url, uri) if uri else None
                current_map_range = _parse_byterange(attrs.get("BYTERANGE", ""))
            elif tag == "#EXTINF":
                raw = value.split(",")[0].strip()
                try:
                    pending_duration = float(raw)
                except ValueError:
                    pending_duration = 0.0
            elif tag == "#EXT-X-BYTERANGE":
                pending_byterange = value.strip()
            elif tag == "#EXT-X-STREAM-INF":
                pending_stream = _parse_attributes(value)
            # 其它标签（I-FRAME-STREAM-INF、MEDIA 等）忽略
            continue

        # 非注释行：可能是变体地址，也可能是片段地址
        uri = urljoin(base_url, line)
        if pending_stream is not None:
            resolution = pending_stream.get("RESOLUTION") or None
            frame_rate: Optional[float] = None
            try:
                frame_rate = float(pending_stream.get("FRAME-RATE", ""))
            except ValueError:
                frame_rate = None
            try:
                bandwidth = int(pending_stream.get("BANDWIDTH", "0"))
            except ValueError:
                bandwidth = 0
            variants.append(Variant(
                url=uri,
                bandwidth=bandwidth,
                resolution=resolution,
                codecs=pending_stream.get("CODECS"),
                frame_rate=frame_rate,
            ))
            pending_stream = None
            continue

        byterange: Optional[ByteRange] = None
        if pending_byterange:
            raw_range = _parse_byterange(pending_byterange)
            if raw_range is not None:
                explicit_offset = "@" in pending_byterange
                offset = raw_range.offset
                if not explicit_offset:
                    offset = last_range.get(uri, 0)
                byterange = ByteRange(length=raw_range.length, offset=offset)
                last_range[uri] = byterange.end + 1
            pending_byterange = None

        segments.append(Segment(
            index=index,
            url=uri,
            duration=float(pending_duration or 0.0),
            sequence=media_sequence + index,
            key=current_key,
            byterange=byterange,
            map_uri=current_map_uri,
            map_byterange=current_map_range,
        ))
        index += 1
        pending_duration = None

    if variants:
        return MasterPlaylist(url=base_url, variants=variants, version=version)
    if not segments:
        raise PlaylistError("播放列表里没有媒体片段（可能是 master 或直播列表为空）")
    return MediaPlaylist(
        url=base_url,
        segments=segments,
        media_sequence=media_sequence,
        target_duration=target_duration,
        version=version,
        has_endlist=has_endlist,
        playlist_type=playlist_type,
    )


def select_segments(playlist: MediaPlaylist,
                    start: Optional[float] = None,
                    end: Optional[float] = None) -> List[Segment]:
    """按秒裁剪，返回覆盖 ``[start, end)`` 的片段子集（整片段为单位）。

    ``start`` / ``end`` 为 None 时表示从头 / 到尾。若区间内没有片段则抛错。
    """
    segs = playlist.segments
    if start is None and end is None:
        return list(segs)
    start_s = max(0.0, float(start or 0.0))
    if end is not None and end <= start_s:
        raise PlaylistError(f"裁剪区间无效：start={start_s:.2f}, end={end}")
    picked: List[Segment] = []
    cursor = 0.0
    for seg in segs:
        seg_start = cursor
        seg_end = cursor + max(seg.duration, 0.0)
        cursor = seg_end
        if seg_end <= start_s:
            continue
        if end is not None and seg_start >= end:
            break
        picked.append(seg)
    if not picked:
        raise PlaylistError(
            f"裁剪区间 {start_s:.1f}s ~ {end}s 内没有片段（播放列表总时长约 "
            f"{playlist.total_duration:.1f}s）"
        )
    return picked


def selection_start_time(playlist: MediaPlaylist,
                         segments: Sequence[Segment]) -> float:
    """返回所选片段在整条流中的开始时间（秒）。

    ``select_segments`` 以整片段为单位裁剪，第一个片段可能比 ``start`` 更早开始；
    用这个时间可以算出 ffmpeg 需要跳过的精确偏移。
    """
    if not segments:
        return 0.0
    first_index = segments[0].index
    if first_index <= 0:
        return 0.0
    return sum(max(seg.duration, 0.0) for seg in playlist.segments[:first_index])


def trim_args(playlist: MediaPlaylist, segments: Sequence[Segment],
              start: Optional[float], end: Optional[float]) -> Tuple[float, Optional[float]]:
    """换算 ffmpeg 裁剪参数：返回 ``(开头需要跳过的秒数, 目标时长或 None)``。"""
    if start is None and end is None:
        return 0.0, None
    start_s = max(0.0, float(start or 0.0))
    skip = max(0.0, start_s - selection_start_time(playlist, segments))
    duration: Optional[float] = None
    if end is not None:
        duration = max(0.0, float(end) - start_s)
    return skip, duration


# ---------------------------------------------------------------------------
# 下载器
# ---------------------------------------------------------------------------


class HLSDownloader:
    """HLS 下载器。

    参数
    ----
    url : m3u8 地址（媒体播放列表或 master 播放列表均可）
    headers : 额外请求头字典（会覆盖默认 UA / Referer）
    user_agent : 自定义 User-Agent
    referer : 自定义 Referer；缺省按播放列表地址推导为 ``scheme://host/``
    concurrency : 并发数，默认 32，可设 1~128
    retries : 每个片段失败后的重试次数（默认 4，指数退避）
    verify_ssl : 是否校验 HTTPS 证书，默认 False（本工具面向自签/证书链异常的站点）
    on_progress : 进度回调 ``callable(ProgressInfo)``
    on_log : 日志回调 ``callable(level, message)``，level 为 info/warn/error
    """

    def __init__(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        user_agent: Optional[str] = None,
        referer: Optional[str] = None,
        concurrency: int = DEFAULT_CONCURRENCY,
        retries: int = DEFAULT_RETRIES,
        verify_ssl: bool = False,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
        total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
        on_progress: Optional[Callable[[ProgressInfo], None]] = None,
        on_log: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        if not isinstance(url, str) or not url.strip():
            raise ValueError("必须提供 m3u8 链接")
        url = url.strip()
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"不支持的链接：{url!r}（只支持 http/https 的 m3u8 地址）")
        if not (1 <= int(concurrency)):
            raise ValueError(_CONCURRENCY_ERROR)
        concurrency = min(int(concurrency), MAX_CONCURRENCY)

        self.url = url
        self.concurrency = concurrency
        self.retries = max(0, int(retries))
        self.verify_ssl = bool(verify_ssl)
        self.connect_timeout = float(connect_timeout)
        self.read_timeout = float(read_timeout)
        self.total_timeout = float(total_timeout)

        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.referer = referer if referer is not None else self._default_referer(url)
        self.extra_headers = dict(headers or {})
        self._headers = self._build_headers()

        self.on_progress = on_progress
        self.on_log = on_log

        self.playlist: Optional[MediaPlaylist] = None
        self.master: Optional[MasterPlaylist] = None

        # 运行期状态
        self._cancel_event = threading.Event()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._task: Optional[asyncio.Task] = None
        self._phase = "init"
        self._seg_total = 0
        self._seg_done = 0
        self._decrypt_done = 0
        self._bytes = 0
        self._started_at = 0.0
        self._download_started_at = 0.0
        self._output_path: Optional[str] = None
        self._last_emit = 0.0
        self._logged_retries = 0

    # -- 兼容/辅助 -------------------------------------------------------

    @staticmethod
    def _default_referer(url: str) -> str:
        parsed = urlparse(url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}/"
        return ""

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "User-Agent": self.user_agent,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
        if self.referer:
            headers["Referer"] = self.referer
        # 用户自定义头优先（大小写不敏感覆盖）
        for key, value in self.extra_headers.items():
            for existing in list(headers):
                if existing.lower() == key.lower():
                    headers.pop(existing)
            headers[str(key)] = str(value)
        return headers

    @property
    def headers(self) -> Dict[str, str]:
        return dict(self._headers)

    @property
    def cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def _log(self, level: str, message: str) -> None:
        if self.on_log is not None:
            try:
                self.on_log(level, message)
            except Exception:  # 回调异常不应影响下载
                pass

    def info(self, message: str) -> None:
        self._log("info", message)

    def warn(self, message: str) -> None:
        self._log("warn", message)

    def _check_cancelled(self) -> None:
        if self._cancel_event.is_set():
            raise DownloadCancelled("下载已取消")

    async def _cancel_sleep(self, seconds: float) -> None:
        """可被取消打断的 sleep。"""
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            self._check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            await asyncio.sleep(min(remaining, 0.2))

    # -- 进度 -------------------------------------------------------------

    def _phase_percent(self) -> float:
        phase = self._phase
        if phase in ("init", ""):
            return 0.0
        if phase == "fetch_playlist":
            return 2.0
        if phase == "fetch_key":
            return 3.0
        if phase == "download":
            if self._seg_total:
                return 3.0 + 92.0 * self._seg_done / self._seg_total
            return 3.0
        if phase == "decrypt":
            if self._seg_total:
                return 95.0 + 2.0 * self._decrypt_done / self._seg_total
            return 95.0
        if phase == "mux":
            return 98.0
        if phase == "probe":
            return 99.0
        if phase == "done":
            return 100.0
        return 0.0

    def _emit(self, phase: Optional[str] = None, message: Optional[str] = None,
              *, force: bool = False) -> None:
        if phase is not None:
            self._phase = phase
        if self.on_progress is None:
            return
        now = time.monotonic()
        # 限流：下载阶段每 120ms 最多一次（靠进度信息仍平滑）
        if not force and now - self._last_emit < 0.12 and self._phase == "download":
            return
        self._last_emit = now
        speed = 0.0
        eta: Optional[float] = None
        if self._phase == "download" and self._download_started_at:
            elapsed_dl = max(now - self._download_started_at, 0.001)
            speed = self._bytes / elapsed_dl
            if self._seg_done:
                per_seg = elapsed_dl / self._seg_done
                eta = max(self._seg_total - self._seg_done, 0) * per_seg
        total_estimate: Optional[int] = None
        if self._seg_done >= 3 and self._seg_total:
            avg = self._bytes / self._seg_done
            total_estimate = int(avg * self._seg_total)
        info = ProgressInfo(
            phase=self._phase,
            message=message or "",
            percent=self._phase_percent(),
            segments_done=self._seg_done,
            segments_total=self._seg_total,
            downloaded_bytes=self._bytes,
            total_bytes_estimate=total_estimate,
            speed_bps=speed,
            eta_seconds=eta,
            elapsed_seconds=now - self._started_at if self._started_at else 0.0,
            output_path=self._output_path,
        )
        try:
            self.on_progress(info)
        except Exception:  # 回调异常不应影响下载
            pass

    # -- 取消 -------------------------------------------------------------

    def cancel(self) -> None:
        """请求取消（可从任意线程调用），下载会抛出 :class:`DownloadCancelled`。"""
        self._cancel_event.set()
        loop = self._loop
        task = self._task
        if loop is not None and task is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(task.cancel)
            except RuntimeError:
                pass

    # -- 网络 -------------------------------------------------------------

    @contextlib.asynccontextmanager
    async def _make_session(self):
        if aiohttp is None:
            raise HLSError(
                f"缺少 aiohttp 依赖（{_AIOHTTP_ERROR}）。请确认工作区 _tools 或 "
                f"嵌入式 Python 的 site-packages 中有 aiohttp。"
            )
        connector = aiohttp.TCPConnector(
            limit=self.concurrency + 16,
            limit_per_host=self.concurrency + 16,
            ssl=False if not self.verify_ssl else None,
            enable_cleanup_closed=True,
        )
        timeout = aiohttp.ClientTimeout(
            total=self.total_timeout,
            connect=self.connect_timeout,
            sock_read=self.read_timeout,
        )
        session = aiohttp.ClientSession(
            headers=self._headers, timeout=timeout, connector=connector,
            trust_env=False,
        )
        try:
            yield session
        finally:
            await session.close()
            await asyncio.sleep(0)  # 让连接释放回调跑完，避免 "Unclosed connector" 噪音

    async def _fetch_bytes(self, session, url: str, *,
                           byterange: Optional[ByteRange] = None,
                           label: str = "") -> bytes:
        """下载一个资源（带重试）。返回原始字节。"""
        headers: Dict[str, str] = {}
        if byterange is not None:
            headers["Range"] = byterange.header_value()
        last_error: Optional[BaseException] = None
        attempts = self.retries + 1
        for attempt in range(1, attempts + 1):
            self._check_cancelled()
            try:
                async with session.get(url, headers=headers) as resp:
                    status = resp.status
                    if status in (200, 206):
                        data = await resp.read()
                        if byterange is not None and status == 200:
                            # 服务端不支持 Range 时手工切片
                            data = data[byterange.offset:byterange.offset + byterange.length]
                        if len(data) == 0:
                            raise DownloadError("服务器返回空内容")
                        return data
                    if status in (400, 401, 404, 410):
                        raise DownloadError(f"HTTP {status}（{url}）")
                    raise DownloadError(f"HTTP {status}")
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError, DownloadError) as exc:
                last_error = exc
                if attempt >= attempts:
                    break
                delay = min(0.4 * (2 ** (attempt - 1)), 8.0)
                if self._logged_retries < 20:
                    self._logged_retries += 1
                    self._log("warn", f"{label or '资源'} 下载失败（第 {attempt}/{attempts} 次）：{exc}，"
                                       f"{delay:.1f}s 后重试")
                await self._cancel_sleep(delay)
        if isinstance(last_error, DownloadError):
            raise last_error
        raise DownloadError(f"{label or url} 下载失败（已重试 {attempts} 次）：{last_error}") from last_error

    # -- 播放列表 ---------------------------------------------------------

    async def fetch_playlist(self, session=None) -> MediaPlaylist:
        """获取并解析播放列表（master 自动选最高码率），返回媒体播放列表。"""
        if session is None:
            async with self._make_session() as sess:
                return await self._load_playlist(sess, self.url, 0)
        return await self._load_playlist(session, self.url, 0)

    async def _load_playlist(self, session, url: str, depth: int) -> MediaPlaylist:
        if depth > 2:
            raise PlaylistError("master 播放列表嵌套层级过深")
        self._phase = "fetch_playlist"
        self._emit("fetch_playlist", f"正在获取播放列表：{url}", force=True)
        raw = await self._fetch_bytes(session, url, label="播放列表")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        parsed = parse_m3u8(text, url)
        if isinstance(parsed, MasterPlaylist):
            self.master = parsed
            self._log("info", f"检测到 master 播放列表，共 {len(parsed.variants)} 个码率变体")
            best = parsed.best_variant()
            self._log("info", f"自动选择最高码率：{best.describe()}")
            self._emit("fetch_playlist", f"已选择码率：{best.describe()}", force=True)
            return await self._load_playlist(session, best.url, depth + 1)
        self._log("info", f"媒体播放列表解析成功：{len(parsed.segments)} 个片段，"
                          f"总时长 {format_duration(parsed.total_duration)}"
                          + (f"，加密方式 {', '.join(parsed.encryption_methods())}"
                             if parsed.is_encrypted else "，未加密"))
        if not parsed.has_endlist:
            self._log("warn", "未发现 EXT-X-ENDLIST，可能是直播/实时列表，只能下载当前可见片段")
        self._emit("fetch_playlist", "播放列表解析完成", force=True)
        return parsed

    async def probe(self) -> PlaylistSummary:
        """探测播放列表信息（不下载任何片段）。"""
        async with self._make_session() as session:
            playlist = await self._load_playlist(session, self.url, 0)
        master = self.master
        return PlaylistSummary(
            url=self.url,
            is_master=master is not None,
            final_url=playlist.url,
            variants=list(master.variants) if master else [],
            segments=len(playlist.segments),
            duration_seconds=playlist.total_duration,
            target_duration=playlist.target_duration,
            encrypted=playlist.is_encrypted,
            encryption_methods=playlist.encryption_methods(),
            is_live=not playlist.has_endlist,
            version=playlist.version,
        )

    # -- 密钥 / 初始化段 ---------------------------------------------------

    async def _ensure_keys(self, session, segments: Sequence[Segment]) -> Dict[str, bytes]:
        """下载所有需要的 AES 密钥，返回 ``{uri: key_bytes}``。"""
        needed: Dict[str, KeyInfo] = {}
        for seg in segments:
            key = seg.key
            if key is None or key.method.upper() == "NONE":
                continue
            method = key.method.upper()
            if method != "AES-128":
                raise UnsupportedError(
                    f"不支持的加密方式 {key.method}（目前仅支持 AES-128；"
                    f"SAMPLE-AES 等需要额外解密流程）"
                )
            if key.keyformat and key.keyformat.lower() not in ("identity", ""):
                raise UnsupportedError(
                    f"不支持的 KEYFORMAT={key.keyformat!r}（仅支持 identity）"
                )
            if not key.uri:
                raise PlaylistError("EXT-X-KEY 缺少 URI，无法获取密钥")
            needed.setdefault(key.uri, key)
        if not needed:
            self._log("info", "流未加密，跳过密钥获取")
            return {}

        self._emit("fetch_key", f"正在获取 {len(needed)} 个密钥", force=True)
        keys: Dict[str, bytes] = {}
        for key_uri, key_info in needed.items():
            data = await self._fetch_bytes(session, key_uri, label="密钥")
            if len(data) not in _AES_KEY_LENGTHS:
                raise PlaylistError(
                    f"密钥长度异常：{len(data)} 字节（AES 密钥应为 16/24/32 字节）"
                )
            keys[key_uri] = data
            self._log("info", f"密钥已获取：{key_uri}（{len(data)} 字节，{key_info.method}）")
        return keys

    async def _ensure_init_segments(self, session, segments: Sequence[Segment]) -> Dict[str, bytes]:
        """下载 ``EXT-X-MAP`` 初始化段（fMP4），返回 ``{uri: bytes}``。"""
        needed: Dict[str, Optional[ByteRange]] = {}
        for seg in segments:
            if seg.map_uri:
                needed.setdefault(seg.map_uri, seg.map_byterange)
        if not needed:
            return {}
        self._log("info", f"检测到 {len(needed)} 个初始化段（fMP4），开始下载")
        result: Dict[str, bytes] = {}
        for uri, byterange in needed.items():
            result[uri] = await self._fetch_bytes(
                session, uri, byterange=byterange, label="初始化段"
            )
        return result

    # -- 片段下载 ---------------------------------------------------------

    def _segment_key_bytes(self, seg: Segment, keys: Dict[str, bytes]) -> Optional[bytes]:
        if seg.key is None or seg.key.method.upper() == "NONE":
            return None
        if not seg.key.uri:
            return None
        key = keys.get(seg.key.uri)
        if key is None:
            raise PlaylistError(f"片段 {seg.index} 的密钥尚未下载：{seg.key.uri}")
        return key

    async def _download_segments(self, session, segments: Sequence[Segment],
                                 temp_dir: Path) -> List[Path]:
        """并发下载所有片段到磁盘，返回按顺序排列的片段文件路径列表。"""
        total = len(segments)
        self._seg_total = total
        self._seg_done = 0
        self._bytes = 0
        self._download_started_at = time.monotonic()
        self._phase = "download"
        self._log("info", f"开始下载 {total} 个片段（并发 {self.concurrency}，"
                          f"失败重试 {self.retries} 次）")
        self._emit("download", "开始下载片段", force=True)

        semaphore = asyncio.Semaphore(self.concurrency)
        paths: List[Optional[Path]] = [None] * total

        async def worker(i: int, seg: Segment) -> None:
            async with semaphore:
                self._check_cancelled()
                data = await self._fetch_bytes(
                    session, seg.url, byterange=seg.byterange,
                    label=f"片段 {i + 1}/{total}",
                )
                path = temp_dir / f"{i:06d}.seg"
                await asyncio.to_thread(_write_bytes, path, data)
                paths[i] = path
                self._seg_done += 1
                self._bytes += len(data)
                self._emit("download")

        tasks = [asyncio.ensure_future(worker(i, seg)) for i, seg in enumerate(segments)]
        try:
            await asyncio.gather(*tasks)
        except BaseException:  # 取消或失败：先取消其余任务再抛出
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        missing = [i for i, p in enumerate(paths) if p is None]
        if missing:
            raise DownloadError(f"{len(missing)} 个片段未能落盘：{missing[:10]}")
        elapsed = time.monotonic() - self._download_started_at
        self._log("info", f"片段下载完成：{total} 个，{format_bytes(self._bytes)}，"
                          f"耗时 {elapsed:.1f}s，平均 "
                          f"{format_speed(self._bytes / max(elapsed, 0.001))}")
        return [p for p in paths if p is not None]

    # -- 解密 + 拼接 -------------------------------------------------------

    async def _decrypt_concat(self, segments: Sequence[Segment], segment_paths: Sequence[Path],
                              keys: Dict[str, bytes], inits: Dict[str, bytes],
                              concat_path: Path) -> int:
        """按顺序解密并拼接为 TS，返回解密后的总字节数。"""
        total = len(segments)
        backend = aes_backend_name()
        if any(s.key is not None for s in segments) and not HAS_PYCRYPTODOME:
            self._log("warn", "未找到 pycryptodome，正在使用内置纯 Python AES（速度较慢）")
        self._log("info", f"开始解密拼接：{total} 个片段（AES 后端：{backend}）")
        self._decrypt_done = 0
        self._phase = "decrypt"
        self._emit("decrypt", "正在解密并拼接片段", force=True)
        batch_size = 24

        out = open(concat_path, "wb")
        written = 0
        try:
            for batch_start in range(0, total, batch_size):
                batch_end = min(batch_start + batch_size, total)
                batch = list(range(batch_start, batch_end))

                def _work(batch_idx: List[int]) -> int:
                    n = 0
                    prev_map: Optional[str] = None
                    if batch_idx and batch_idx[0] > 0:
                        prev_map = segments[batch_idx[0] - 1].map_uri
                    for i in batch_idx:
                        seg = segments[i]
                        if seg.map_uri and seg.map_uri != prev_map:
                            raw_init = inits.get(seg.map_uri)
                            if raw_init:
                                out.write(raw_init)
                                n += len(raw_init)
                        prev_map = seg.map_uri
                        data = Path(segment_paths[i]).read_bytes()
                        key = self._segment_key_bytes(seg, keys)
                        iv = seg.iv if key else None
                        if key:
                            decrypted = decrypt_segment(data, key, iv)
                        else:
                            decrypted = data
                        out.write(decrypted)
                        n += len(decrypted)
                    return n

                batch_bytes = await asyncio.to_thread(_work, batch)
                written += batch_bytes
                self._decrypt_done = batch_end
                self._emit("decrypt")
            await asyncio.to_thread(out.flush)
            await asyncio.to_thread(os.fsync, out.fileno())
        finally:
            await asyncio.to_thread(out.close)
        if written <= 0:
            raise DownloadError("解密拼接后没有任何数据，请检查片段是否有效")
        self._log("info", f"解密拼接完成：{format_bytes(written)} -> {concat_path}")
        return written

    # -- ffmpeg -----------------------------------------------------------

    def _ffmpeg_cmd_path(self) -> str:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise FFmpegError(
                "未找到 ffmpeg 可执行文件。\n"
                "  - 可把 ffmpeg.exe 放到 PATH 中，或\n"
                "  - 设置环境变量 HLS_FFMPEG 指向 ffmpeg.exe，或\n"
                "  - 保持工作区 _tools/imageio_ffmpeg/binaries/ 目录结构不变，或\n"
                "  - 使用 --no-mp4 只输出 TS 文件（无需 ffmpeg）"
            )
        return ffmpeg

    async def _mux_mp4(self, concat_path: Path, out_path: Path, *,
                       trim_start: float = 0.0,
                       trim_duration: Optional[float] = None) -> None:
        """调用 ffmpeg 无重编码封装 MP4（失败时抛出清晰错误）。"""
        ffmpeg = self._ffmpeg_cmd_path()
        self._phase = "mux"
        self._emit("mux", "正在调用 ffmpeg 封装 MP4", force=True)
        tmp_out = out_path.with_name(out_path.name + ".part")
        if tmp_out.exists():
            try:
                tmp_out.unlink()
            except OSError:
                pass
        cmd: List[str] = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
        if trim_start and trim_start > 0.001:
            cmd += ["-ss", f"{trim_start:.3f}"]
        cmd += ["-i", str(concat_path)]
        if trim_duration is not None and trim_duration > 0:
            cmd += ["-t", f"{trim_duration:.3f}"]
        cmd += [
            "-map", "0:v:0?", "-map", "0:a:0?",
            "-c", "copy", "-movflags", "+faststart",
            "-f", "mp4", str(tmp_out),
        ]
        self._log("info", f"执行 ffmpeg 封装（-c copy，无重编码）")
        self._log("info", " ".join(cmd))
        try:
            proc = await asyncio.to_thread(
                subprocess.run, cmd,
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            raise FFmpegError(f"无法启动 ffmpeg（{ffmpeg}）：{exc}") from exc
        if proc.returncode != 0:
            tail = "\n".join((proc.stderr or "").splitlines()[-12:])
            raise FFmpegError(
                "ffmpeg 封装 MP4 失败（退出码 %s）。\n"
                "常见原因：输入 TS 流的编码与 MP4 容器不兼容、输入文件损坏。\n"
                "可以尝试 --no-mp4 直接输出 TS 文件。\n"
                "ffmpeg 输出：\n%s" % (proc.returncode, tail)
            )
        if not tmp_out.is_file() or tmp_out.stat().st_size <= 0:
            raise FFmpegError("ffmpeg 返回成功但未生成有效的 MP4 文件")
        await asyncio.to_thread(os.replace, str(tmp_out), str(out_path))
        self._log("info", f"MP4 封装完成：{out_path}（{format_bytes(out_path.stat().st_size)}）")

    async def _probe_media(self, media_path: Path) -> Tuple[float, List[str], List[str]]:
        """用 ffmpeg 读取媒体信息，返回 (时长秒, 视频流描述, 音频流描述)。"""
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            return 0.0, [], []
        cmd = [ffmpeg, "-hide_banner", "-i", str(media_path)]
        try:
            proc = await asyncio.to_thread(
                subprocess.run, cmd,
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            return 0.0, [], []
        text = proc.stderr or ""
        duration = 0.0
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
        if m:
            duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        video: List[str] = []
        audio: List[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("Stream #"):
                continue
            if "Video:" in stripped:
                video.append(_describe_stream(stripped, "Video:"))
            elif "Audio:" in stripped:
                audio.append(_describe_stream(stripped, "Audio:"))
        return duration, video, audio

    # -- 下载主流程 -------------------------------------------------------

    def _normalise_out_path(self, out_path: Union[str, Path], no_mp4: bool) -> Path:
        path = Path(out_path).expanduser()
        if not path.is_absolute():
            path = default_output_dir() / path
        if not path.suffix:
            path = path.with_suffix(".ts" if no_mp4 else ".mp4")
        return path

    async def async_download(
        self,
        out_path: Union[str, Path],
        *,
        start: Optional[float] = None,
        end: Optional[float] = None,
        keep_ts: bool = False,
        no_mp4: bool = False,
    ) -> DownloadResult:
        """异步下载入口（事件循环内调用）。"""
        self._cancel_event.clear()
        self._started_at = time.monotonic()
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.current_task()
        try:
            try:
                return await self._run(
                    out_path, start=start, end=end, keep_ts=keep_ts, no_mp4=no_mp4
                )
            except asyncio.CancelledError:
                self._phase = "cancelled"
                self._emit("cancelled", "下载已取消", force=True)
                raise DownloadCancelled("下载已取消") from None
        finally:
            self._task = None

    def download(
        self,
        out_path: Union[str, Path],
        *,
        start: Optional[float] = None,
        end: Optional[float] = None,
        keep_ts: bool = False,
        no_mp4: bool = False,
    ) -> DownloadResult:
        """同步下载入口（内部创建事件循环，可直接在线程中调用）。"""
        return asyncio.run(self.async_download(
            out_path, start=start, end=end, keep_ts=keep_ts, no_mp4=no_mp4,
        ))

    async def _run(self, out_path: Union[str, Path], *,
                   start: Optional[float],
                   end: Optional[float],
                   keep_ts: bool,
                   no_mp4: bool) -> DownloadResult:
        self._check_cancelled()
        out_path = self._normalise_out_path(out_path, no_mp4)
        if no_mp4 and out_path.suffix.lower() in (".mp4", ".m4v", ".mkv", ".webm"):
            fixed = out_path.with_suffix(".ts")
            self._log("warn", f"--no-mp4 输出改为 TS 后缀：{fixed.name}")
            out_path = fixed
        out_path.parent.mkdir(parents=True, exist_ok=True)
        self._output_path = str(out_path)
        temp_dir = Path(tempfile.mkdtemp(prefix=".hls_dl_", dir=str(out_path.parent)))
        self._log("info", f"临时目录：{temp_dir}")
        started = time.monotonic()
        written = 0
        try:
            async with self._make_session() as session:
                playlist = await self._load_playlist(session, self.url, 0)
                self.playlist = playlist
                segments = select_segments(playlist, start, end)
                if start is not None or end is not None:
                    offset = selection_start_time(playlist, segments)
                    self._log("info", f"按时间裁剪：{start if start is not None else 0:.2f}s ~ "
                                      f"{end if end is not None else playlist.total_duration:.2f}s，"
                                      f"实际下载 {len(segments)}/{len(playlist.segments)} 个片段"
                                      f"（片段起点 {offset:.2f}s）")
                keys = await self._ensure_keys(session, segments)
                inits = await self._ensure_init_segments(session, segments)
                segment_paths = await self._download_segments(session, segments, temp_dir)

            network_bytes = self._bytes
            concat_path = temp_dir / "concat.ts"
            written = await self._decrypt_concat(
                segments, segment_paths, keys, inits, concat_path
            )

            trim_start, trim_duration = trim_args(playlist, segments, start, end)
            ts_path: Optional[str] = None
            duration = 0.0
            video: List[str] = []
            audio: List[str] = []
            muxed = False
            final_path: Path

            if no_mp4:
                final_path = out_path
                await asyncio.to_thread(_move_file, concat_path, final_path)
                self._phase = "probe"
                self._emit("probe", "正在校验输出", force=True)
                duration, video, audio = await self._probe_media(final_path)
                if not duration:
                    duration = self._clip_duration(segments, start, end)
            else:
                await self._mux_mp4(concat_path, out_path,
                                    trim_start=trim_start, trim_duration=trim_duration)
                final_path = out_path
                self._phase = "probe"
                self._emit("probe", "正在校验输出", force=True)
                duration, video, audio = await self._probe_media(final_path)
                if not duration:
                    duration = self._clip_duration(segments, start, end)
                muxed = True
                if keep_ts:
                    ts_target = out_path.with_suffix(".ts") \
                        if out_path.suffix.lower() != ".ts" \
                        else out_path.with_name(out_path.stem + "_raw.ts")
                    await asyncio.to_thread(_move_file, concat_path, ts_target)
                    ts_path = str(ts_target)
                    self._log("info", f"已保留 TS 文件：{ts_path}")

            size = final_path.stat().st_size
            result = DownloadResult(
                output_path=str(final_path),
                ts_path=ts_path,
                size_bytes=size,
                duration_seconds=duration,
                clip_seconds=self._clip_duration(segments, start, end),
                segments_downloaded=len(segments),
                bytes_downloaded=network_bytes,
                elapsed_seconds=time.monotonic() - started,
                muxed=muxed,
                playlist_duration=playlist.total_duration,
                video_streams=video,
                audio_streams=audio,
                aes_backend=aes_backend_name(),
            )
            self._phase = "done"
            self._emit("done", "下载完成", force=True)
            self._log("info", f"任务完成：{final_path}（{format_bytes(size)}，"
                              f"时长 {format_duration(duration)}，耗时 "
                              f"{result.elapsed_seconds:.1f}s）")
            return result
        except DownloadCancelled:
            self._phase = "cancelled"
            self._emit("cancelled", "下载已取消", force=True)
            self._log("warn", "下载已取消，正在清理临时文件")
            raise
        except asyncio.CancelledError:
            self._phase = "cancelled"
            self._emit("cancelled", "下载已取消", force=True)
            raise DownloadCancelled("下载已取消") from None
        except HLSError:
            self._phase = "error"
            raise
        except Exception as exc:
            self._phase = "error"
            raise DownloadError(f"下载失败：{exc}") from exc
        finally:
            # 清理半成品与临时目录（keep_ts 保留的 TS 已移动到输出目录）
            try:
                part = out_path.with_name(out_path.name + ".part")
                if part.exists():
                    part.unlink()
            except OSError:
                pass
            shutil.rmtree(temp_dir, ignore_errors=True)

    @staticmethod
    def _clip_duration(segments: Sequence[Segment],
                       start: Optional[float], end: Optional[float]) -> float:
        if start is None and end is None:
            return sum(s.duration for s in segments)
        start_s = max(0.0, float(start or 0.0))
        if end is None:
            return max(0.0, sum(s.duration for s in segments) - start_s)
        return max(0.0, float(end) - start_s)


# ---------------------------------------------------------------------------
# 内部工具函数
# ---------------------------------------------------------------------------


def _write_bytes(path: Path, data: bytes) -> None:
    with open(path, "wb") as fh:
        fh.write(data)


def _move_file(src: Path, dst: Path) -> None:
    """移动文件；跨盘时回退为复制+删除。"""
    try:
        os.replace(str(src), str(dst))
    except OSError:
        shutil.copyfile(str(src), str(dst))
        try:
            src.unlink()
        except OSError:
            pass


def _describe_stream(line: str, kind: str) -> str:
    """从 ffmpeg 的 ``Stream #`` 行里提取简洁描述，如 ``h264 (High), 2560x1440``。"""
    tail = line.split(kind, 1)[1].strip() if kind in line else line.strip()
    codec = tail.split(",", 1)[0].strip()
    if kind == "Video:":
        resolution = re.search(r"(\d{2,5}x\d{2,5})", tail)
        return f"{codec}, {resolution.group(1)}" if resolution else codec
    rate = re.search(r"(\d+ Hz)", tail)
    channels = re.search(r"(stereo|mono|\d+ channels)", tail)
    bits = [codec]
    if rate:
        bits.append(rate.group(1))
    if channels:
        bits.append(channels.group(1))
    return ", ".join(bits)


# ---------------------------------------------------------------------------
# 模块级便捷函数
# ---------------------------------------------------------------------------


def probe_playlist(url: str, *, headers: Optional[Dict[str, str]] = None,
                   user_agent: Optional[str] = None, referer: Optional[str] = None,
                   verify_ssl: bool = False,
                   on_log: Optional[Callable[[str, str], None]] = None) -> PlaylistSummary:
    """同步探测播放列表信息（不下载片段）。"""
    downloader = HLSDownloader(
        url, headers=headers, user_agent=user_agent, referer=referer,
        verify_ssl=verify_ssl, on_log=on_log,
    )
    return asyncio.run(downloader.probe())


def download_media(
    url: str,
    out_path: Union[str, Path],
    *,
    headers: Optional[Dict[str, str]] = None,
    user_agent: Optional[str] = None,
    referer: Optional[str] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    retries: int = DEFAULT_RETRIES,
    verify_ssl: bool = False,
    start: Optional[float] = None,
    end: Optional[float] = None,
    keep_ts: bool = False,
    no_mp4: bool = False,
    on_progress: Optional[Callable[[ProgressInfo], None]] = None,
    on_log: Optional[Callable[[str, str], None]] = None,
) -> DownloadResult:
    """一行代码完成下载的便捷函数（同步）。"""
    downloader = HLSDownloader(
        url, headers=headers, user_agent=user_agent, referer=referer,
        concurrency=concurrency, retries=retries, verify_ssl=verify_ssl,
        on_progress=on_progress, on_log=on_log,
    )
    return downloader.download(out_path, start=start, end=end,
                               keep_ts=keep_ts, no_mp4=no_mp4)


__all__ = [
    "__version__",
    "HLSDownloader",
    "ProgressInfo",
    "DownloadResult",
    "PlaylistSummary",
    "MasterPlaylist",
    "MediaPlaylist",
    "Segment",
    "Variant",
    "KeyInfo",
    "ByteRange",
    "HLSError",
    "PlaylistError",
    "DownloadError",
    "UnsupportedError",
    "DownloadCancelled",
    "FFmpegError",
    "parse_m3u8",
    "select_segments",
    "decrypt_segment",
    "probe_playlist",
    "download_media",
    "ensure_tools_on_path",
    "find_ffmpeg",
    "workspace_root",
    "default_output_dir",
    "default_output_name",
    "unique_path",
    "format_bytes",
    "format_duration",
    "format_speed",
    "aes_backend_name",
    "HAS_PYCRYPTODOME",
    "DEFAULT_USER_AGENT",
    "DEFAULT_CONCURRENCY",
    "MAX_CONCURRENCY",
]
