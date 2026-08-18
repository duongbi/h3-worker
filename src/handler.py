"""
RunPod Serverless handler cho MiniMax-H3 (ComfyUI backend).

Khác biệt so với handler gốc của worker-comfyui:
  1. Hiểu output VIDEO (mp4/webm/mkv) + AUDIO, không chỉ ảnh.
  2. Upload thẳng lên Cloudflare R2 và trả URL — không bao giờ trả base64
     (payload RunPod giới hạn 10MB cho /run, 20MB cho /runsync).
  3. Nhận asset đầu vào qua presigned URL (Ref2VA cần tới 12 file).
  4. Báo tiến độ về RunPod qua progress_update để backend hiển thị cho user.

Input schema
------------
{
  "input": {
    "workflow": { ... },                  # BẮT BUỘC — ComfyUI API-format JSON
    "assets": [                           # tuỳ chọn — tải về /comfyui/input
      {"name": "first_frame.png", "url": "https://..."},
      {"name": "voice.wav", "base64": "data:audio/wav;base64,..."}
    ],
    "meta": {"jobId": "..."},             # echo lại trong response
    "output_prefix": "videos/2026/08"     # tuỳ chọn — prefix key trên R2
  }
}

Output schema
-------------
{
  "videos":  [{"url", "key", "filename", "sizeBytes", "contentType"}],
  "images":  [...],                       # nếu workflow có node SaveImage
  "audios":  [...],
  "meta":    {...},
  "timings": {"queueMs", "executeMs", "uploadMs", "totalMs"},
  "warnings": [...]
}
"""

import base64
import json
import logging
import mimetypes
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import runpod
from runpod.serverless.utils.rp_validator import validate

# --------------------------------------------------------------------------
# Cấu hình
# --------------------------------------------------------------------------
COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_URL = f"http://{COMFY_HOST}"
POLL_INTERVAL = int(os.environ.get("COMFY_POLL_INTERVAL_MS", "1000")) / 1000
MAX_WAIT_SEC = int(os.environ.get("COMFY_MAX_WAIT_SEC", "1800"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/comfyui/output"))
INPUT_DIR = Path(os.environ.get("INPUT_DIR", "/comfyui/input"))

# R2 / S3
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_ENDPOINT = os.environ.get("R2_ENDPOINT_URL", "")       # https://<acct>.r2.cloudflarestorage.com
R2_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_PUBLIC_BASE = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
R2_PRESIGN_EXPIRY = int(os.environ.get("R2_PRESIGN_EXPIRY_SEC", "604800"))  # 7 ngày

VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".gif"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}

INPUT_SCHEMA = {
    "workflow": {"type": dict, "required": True},
    "assets": {"type": list, "required": False, "default": []},
    "meta": {"type": dict, "required": False, "default": {}},
    "output_prefix": {"type": str, "required": False, "default": "videos"},
}

_s3 = None

# httpx log mỗi request ở mức INFO — với poll 1s/lần thì log worker sẽ ngập
logging.getLogger("httpx").setLevel(logging.WARNING)


def log(msg: str) -> None:
    print(f"[h3-worker] {msg}", flush=True)


# --------------------------------------------------------------------------
# R2 / S3
# --------------------------------------------------------------------------
def get_s3():
    """Client R2 dùng chung, khởi tạo lazy để cold start không tốn thêm."""
    global _s3
    if _s3 is None:
        import boto3
        from botocore.config import Config

        if not (R2_BUCKET and R2_ENDPOINT and R2_ACCESS_KEY and R2_SECRET_KEY):
            raise RuntimeError(
                "Thiếu biến môi trường R2: cần R2_BUCKET, R2_ENDPOINT_URL, "
                "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY"
            )
        _s3 = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
            region_name="auto",                       # R2 luôn dùng "auto"
            config=Config(
                signature_version="s3v4",
                # path-style: https://<host>/<bucket>/<key>
                # Không đặt thì boto3 có thể ghép <bucket>.<host> → DNS không phân giải.
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3, "mode": "standard"},
            ),
        )
    return _s3


def upload_to_r2(path: Path, key: str) -> Dict[str, Any]:
    """Upload 1 file lên R2, trả về metadata + URL truy cập được."""
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    s3 = get_s3()
    with path.open("rb") as f:
        s3.upload_fileobj(
            f, R2_BUCKET, key,
            ExtraArgs={"ContentType": content_type, "CacheControl": "public, max-age=31536000"},
        )

    if R2_PUBLIC_BASE:
        # Bucket đã gắn custom domain / r2.dev → URL công khai vĩnh viễn
        url = f"{R2_PUBLIC_BASE}/{key}"
    else:
        # Bucket private → presigned URL có hạn
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": R2_BUCKET, "Key": key},
            ExpiresIn=R2_PRESIGN_EXPIRY,
        )

    return {
        "url": url,
        "key": key,
        "filename": path.name,
        "sizeBytes": path.stat().st_size,
        "contentType": content_type,
    }


# --------------------------------------------------------------------------
# ComfyUI
# --------------------------------------------------------------------------
def _comfy_pids() -> List[int]:
    """PID của tiến trình ComfyUI (python .../main.py) đang chạy trong container."""
    pids = []
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            cmdline = (p / "cmdline").read_bytes().decode("utf-8", "replace")
        except OSError:
            continue                                   # tiến trình vừa thoát
        if "main.py" in cmdline and "python" in cmdline:
            pids.append(int(p.name))
    return pids


def _volume_report() -> str:
    """Mô tả ngắn tình trạng network volume — nguyên nhân hay gặp nhất."""
    base = Path("/runpod-volume")
    if not base.exists():
        return "/runpod-volume KHÔNG tồn tại → network volume chưa gắn vào endpoint."
    models = base / "ComfyUI" / "models" / "diffusion_models"
    if not models.is_dir():
        return f"{models} không tồn tại → volume gắn rồi nhưng sai cấu trúc thư mục."
    return f"{models}: {len(list(models.glob('*.safetensors')))} file .safetensors."


# CUDA 13.0 GA đòi driver Linux >= 580.65.06 (NVIDIA CUDA Toolkit release notes).
_CUDA13_MIN_DRIVER = (580, 65)


def _driver_version() -> Optional[Tuple[int, ...]]:
    """Phiên bản driver NVIDIA của host, đọc từ /proc — không cần import torch."""
    try:
        txt = Path("/proc/driver/nvidia/version").read_text()
    except OSError:
        return None
    m = re.search(r"Kernel Module\s+([0-9]+(?:\.[0-9]+)+)", txt)
    if not m:
        return None
    return tuple(int(x) for x in m.group(1).split("."))


def _gpu_report(stats: Dict[str, Any]) -> str:
    """
    Một dòng: bản torch (kèm +cu1xx) và driver NVIDIA của host.

    Vì sao đáng in mỗi job: image build cho cu130 mà host còn driver r57x thì
    ComfyUI vẫn khởi động bình thường, chỉ chết lúc chạm GPU với
    'CUDA driver version is insufficient for CUDA runtime version' — rất khó lần
    nếu không biết trước. Worker RunPod rơi vào host nào là chuyện hên xui, nên
    con số này phải có trong log của TỪNG job, không phải chỉ lúc build.
    """
    torch_ver = str((stats.get("system") or {}).get("pytorch_version", "?"))
    drv = _driver_version()
    line = f"torch={torch_ver} · driver={'.'.join(map(str, drv)) if drv else 'không đọc được'}"
    if "+cu13" in torch_ver and drv and drv[:2] < _CUDA13_MIN_DRIVER:
        line += (
            f" · ⚠ torch build cho CUDA 13 nhưng driver < "
            f"{_CUDA13_MIN_DRIVER[0]}.{_CUDA13_MIN_DRIVER[1]} → job sẽ chết khi chạm GPU. "
            "Build lại với --build-arg TORCH_CHANNEL=cu128, hoặc trỏ Template về image tag SHA cũ."
        )
    return line


def wait_for_comfy(timeout_sec: int = 600) -> None:
    """
    Chờ ComfyUI sẵn sàng.

    ComfyUI mở cổng 8188 TRƯỚC khi nạp weights (weights nạp lazy lúc chạy prompt),
    nên bình thường chỗ này chỉ mất vài chục giây. 'Connection refused' lặp lại
    gần như luôn nghĩa là tiến trình ComfyUI đã chết, không phải đang chậm —
    phát hiện sớm thay vì đợi hết timeout rồi báo một lỗi vô nghĩa.
    """
    start = time.time()
    deadline = start + timeout_sec
    last_err = None
    next_beat = start + 15
    saw_process = False

    with httpx.Client(timeout=5) as c:
        while time.time() < deadline:
            try:
                r = c.get(f"{COMFY_URL}/system_stats")
                if r.status_code == 200:
                    log(f"ComfyUI sẵn sàng sau {time.time() - start:.0f}s.")
                    try:
                        log(_gpu_report(r.json()))
                    except Exception as e:            # noqa: BLE001 — chỉ là log
                        log(f"Không đọc được /system_stats: {e}")
                    return
                last_err = f"HTTP {r.status_code}"
            except Exception as e:                    # noqa: BLE001
                last_err = e

            pids = _comfy_pids()
            if pids:
                saw_process = True
            elif saw_process or time.time() - start > 20:
                # Đã thấy tiến trình rồi mất → crash.
                # Chưa từng thấy sau 20s → start.sh không chạy được ComfyUI.
                raise RuntimeError(
                    "Tiến trình ComfyUI không chạy trong container ("
                    + ("đã crash sau khi khởi động" if saw_process else "chưa từng khởi động")
                    + f"). Lỗi kết nối cuối: {last_err}. Volume: {_volume_report()} "
                    "Traceback thật nằm ở tab Container trên RunPod console."
                )

            if time.time() >= next_beat:
                log(f"Chờ ComfyUI… {time.time() - start:.0f}s, pid={pids or 'không có'}, lỗi={last_err}")
                next_beat = time.time() + 15
            time.sleep(0.5)

    raise RuntimeError(
        f"ComfyUI không phản hồi sau {timeout_sec}s (lỗi cuối: {last_err}). "
        f"pid ComfyUI: {_comfy_pids() or 'không có'}. Volume: {_volume_report()}"
    )


def stage_assets(assets: List[Dict[str, Any]], warnings: List[str]) -> None:
    """Tải asset đầu vào (URL hoặc base64) vào thư mục input của ComfyUI."""
    if not assets:
        return
    INPUT_DIR.mkdir(parents=True, exist_ok=True)

    with httpx.Client(timeout=120, follow_redirects=True) as c:
        for a in assets:
            name = a.get("name")
            if not name:
                warnings.append("Bỏ qua asset thiếu trường 'name'")
                continue
            # Chặn path traversal — name đến từ request bên ngoài
            dest = INPUT_DIR / Path(name).name

            if a.get("url"):
                r = c.get(a["url"])
                r.raise_for_status()
                dest.write_bytes(r.content)
            elif a.get("base64"):
                raw = a["base64"]
                if "," in raw[:64]:                   # bóc prefix data:...;base64,
                    raw = raw.split(",", 1)[1]
                dest.write_bytes(base64.b64decode(raw))
            else:
                warnings.append(f"Asset '{name}' không có 'url' lẫn 'base64'")
                continue
            log(f"Đã nạp asset {dest.name} ({dest.stat().st_size} bytes)")


def queue_prompt(workflow: Dict[str, Any], client_id: str) -> str:
    with httpx.Client(timeout=60) as c:
        r = c.post(f"{COMFY_URL}/prompt", json={"prompt": workflow, "client_id": client_id})
        if r.status_code != 200:
            # ComfyUI trả 400 kèm node_errors rất chi tiết — surface nguyên vẹn
            raise RuntimeError(f"ComfyUI từ chối workflow ({r.status_code}): {r.text[:2000]}")
        return r.json()["prompt_id"]


def poll_until_done(job: Dict[str, Any], prompt_id: str) -> Dict[str, Any]:
    """
    Poll /history cho tới khi job xong. Đồng thời đọc /queue để biết còn
    đang chờ hay đang chạy, và đẩy progress_update về RunPod.

    progress_update(job, payload) cần chính dict `job` — backend đọc được
    qua GET /status/{id} ở trường `output` khi job còn IN_PROGRESS.
    """
    start_ts = time.time()
    deadline = start_ts + MAX_WAIT_SEC
    last_report = 0.0

    with httpx.Client(timeout=30) as c:
        while time.time() < deadline:
            h = c.get(f"{COMFY_URL}/history/{prompt_id}")
            if h.status_code == 200:
                data = h.json()
                if prompt_id in data:
                    entry = data[prompt_id]
                    status = entry.get("status", {})
                    if status.get("completed") or status.get("status_str") == "success":
                        return entry
                    if status.get("status_str") == "error":
                        raise RuntimeError(_format_comfy_error(status))

            now = time.time()
            if now - last_report > 5:
                last_report = now
                try:
                    q = c.get(f"{COMFY_URL}/queue").json()
                    pending = len(q.get("queue_pending", []))
                    running = len(q.get("queue_running", []))
                    runpod.serverless.progress_update(
                        job,
                        {"state": "running" if running else "queued",
                         "pending": pending,
                         "elapsedSec": int(now - start_ts)},
                    )
                except Exception:                     # noqa: BLE001
                    pass

            time.sleep(POLL_INTERVAL)

    raise TimeoutError(
        f"Job vượt quá {MAX_WAIT_SEC}s. Tăng COMFY_MAX_WAIT_SEC và executionTimeout "
        f"của endpoint, hoặc giảm resolution/số frame."
    )


def _format_comfy_error(status: Dict[str, Any]) -> str:
    parts = []
    for m in status.get("messages", []):
        if isinstance(m, list) and len(m) >= 2 and m[0] in ("execution_error", "execution_interrupted"):
            d = m[1]
            parts.append(
                f"node {d.get('node_id')} ({d.get('node_type')}): "
                f"{d.get('exception_type')} — {d.get('exception_message')}"
            )
    return "ComfyUI execution error: " + ("; ".join(parts) if parts else json.dumps(status)[:1500])


# --------------------------------------------------------------------------
# Thu thập output
# --------------------------------------------------------------------------
def resolve_output_file(item: Dict[str, Any]) -> Optional[Path]:
    """
    Một entry output của ComfyUI có dạng
      {"filename": "H3_00001.mp4", "subfolder": "", "type": "output"}
    VideoHelperSuite đôi khi trả thêm "fullpath" — ưu tiên dùng nếu có.
    """
    if item.get("fullpath"):
        p = Path(item["fullpath"])
        if p.exists():
            return p
    fn = item.get("filename")
    if not fn:
        return None
    p = OUTPUT_DIR / item.get("subfolder", "") / fn
    return p if p.exists() else None


def collect_outputs(entry: Dict[str, Any], warnings: List[str]) -> List[Path]:
    """
    Quét mọi khoá output của mọi node. ComfyUI/VHS dùng nhiều tên khác nhau
    tuỳ node: images, gifs, videos, audio, files... nên ta duyệt hết thay vì
    hardcode 'images' như handler gốc.
    """
    files: List[Path] = []
    seen = set()

    for node_id, node_out in (entry.get("outputs") or {}).items():
        for key, items in node_out.items():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                # bỏ qua preview tạm — chỉ lấy file đã lưu thật
                if item.get("type") == "temp":
                    continue
                p = resolve_output_file(item)
                if p is None:
                    warnings.append(
                        f"Node {node_id}.{key}: không tìm thấy file "
                        f"{item.get('subfolder','')}/{item.get('filename')} trên đĩa"
                    )
                    continue
                if p in seen:
                    continue
                seen.add(p)
                files.append(p)

    return files


def bucketize(uploaded: List[Dict[str, Any]]) -> Tuple[List, List, List]:
    videos, images, audios = [], [], []
    for u in uploaded:
        ext = Path(u["filename"]).suffix.lower()
        if ext in VIDEO_EXT:
            videos.append(u)
        elif ext in AUDIO_EXT:
            audios.append(u)
        elif ext in IMAGE_EXT:
            images.append(u)
    return videos, images, audios


def cleanup(files: List[Path]) -> None:
    """
    Xoá file sau khi upload. Bắt buộc: worker sống lâu qua nhiều job,
    output/ đầy dần sẽ làm hết disk và worker chết giữa chừng.
    """
    for p in files:
        try:
            p.unlink(missing_ok=True)
        except Exception as e:                        # noqa: BLE001
            log(f"Không xoá được {p}: {e}")


# --------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------
def handler(job: Dict[str, Any]) -> Dict[str, Any]:
    t0 = time.time()
    warnings: List[str] = []

    validated = validate(job.get("input") or {}, INPUT_SCHEMA)
    if "errors" in validated:
        return {"error": validated["errors"]}
    inp = validated["validated_input"]

    workflow = inp["workflow"]
    meta = inp["meta"]
    prefix = inp["output_prefix"].strip("/")
    job_id = job.get("id", "unknown")

    wait_for_comfy()
    stage_assets(inp["assets"], warnings)

    t_queue = time.time()
    client_id = str(uuid.uuid4())
    prompt_id = queue_prompt(workflow, client_id)
    log(f"Đã queue prompt {prompt_id}")

    entry = poll_until_done(job, prompt_id)
    t_exec = time.time()

    files = collect_outputs(entry, warnings)
    if not files:
        return {
            "error": "Workflow chạy xong nhưng không sinh ra file output nào. "
                     "Kiểm tra workflow có node lưu file (VHS_VideoCombine / SaveImage) "
                     "và node đó không bị muted.",
            "warnings": warnings,
        }

    uploaded = []
    for p in files:
        key = f"{prefix}/{job_id}/{p.name}"
        uploaded.append(upload_to_r2(p, key))
        log(f"Đã upload {p.name} → {key}")
    t_upload = time.time()

    cleanup(files)
    videos, images, audios = bucketize(uploaded)

    if not videos:
        warnings.append(
            "Không có file video nào trong output — workflow có thể đang thiếu "
            "node ghép video (VHS_VideoCombine)."
        )

    return {
        "videos": videos,
        "images": images,
        "audios": audios,
        "meta": meta,
        "timings": {
            "queueMs": int((t_queue - t0) * 1000),
            "executeMs": int((t_exec - t_queue) * 1000),
            "uploadMs": int((t_upload - t_exec) * 1000),
            "totalMs": int((time.time() - t0) * 1000),
        },
        "warnings": warnings,
    }


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
