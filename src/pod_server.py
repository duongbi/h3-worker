"""
HTTP server cho MiniMax-H3 chạy trên RunPod **Pod** (thay cho Serverless).

VÌ SAO CÓ FILE NÀY
------------------
Chuyển từ Serverless sang Pod thường phải viết lại cả backend: đổi cách gửi job,
đổi cách nhận kết quả, tự upload R2, tự quản queue. File này tránh hết chuyện đó
bằng cách **giả lập đúng hợp đồng HTTP của RunPod Serverless**:

    POST /run          → {"id": "...", "status": "IN_QUEUE"}
    GET  /status/{id}  → {"id","status","output","error","delayTime","executionTime"}
    POST /cancel/{id}  → {"id","status":"CANCELLED"}
    GET  /health       → {"jobs":{...},"workers":{...},"comfy":{...}}

Thêm hai route KHÔNG có ở RunPod, để chẩn đoán trước khi đốt tiền GPU:

    GET  /ping             → {"ok":true}   (không cần auth — cho health check hạ tầng)
    GET  /models/{kind}    → weights ComfyUI thật sự nhìn thấy trên volume

Nhờ vậy `SERVER/libs/runpodHelper.js`, `libs/poller.js` và `routes/runpod-webhook.js`
giữ NGUYÊN không sửa một dòng — chỉ đổi `RUNPOD_BASE_URL` sang URL của Pod và
`RUNPOD_API_KEY` sang `POD_API_KEY`. Muốn quay lại Serverless thì đổi ngược lại,
không có đường một chiều nào cả.

Toàn bộ phần nghiệp vụ (tải asset, queue prompt, gom output, upload R2) DÙNG LẠI
nguyên hàm trong `handler.py` — không có bản copy thứ hai để lệch nhau về sau.
Chỗ duy nhất phải viết lại là vòng poll, vì bản trong handler.py gọi
`runpod.serverless.progress_update()` — thứ không tồn tại ngoài Serverless.

CHỈ DÙNG THƯ VIỆN CHUẨN + httpx (đã có sẵn trong image). Không thêm fastapi/uvicorn:
một GPU thì tải rất thấp, `ThreadingHTTPServer` thừa sức, và mỗi dependency mới là
một lý do nữa để build hỏng.

CHẠY
----
    COMFY_HOST=127.0.0.1:8188 POD_API_KEY=... python -u /pod_server.py

Biến môi trường riêng của file này (phần R2/Comfy dùng chung với handler.py):
    POD_PORT          cổng lắng nghe                (mặc định 8000)
    POD_API_KEY       bắt buộc khớp `Authorization: Bearer ...`. ĐỂ TRỐNG = MỞ CỬA.
    POD_CONCURRENCY   số job chạy song song         (mặc định 1 — một GPU thì để 1)
    POD_JOB_TTL_SEC   giữ job đã xong bao lâu       (mặc định 86400)
    POD_QUEUE_MAX     số job tối đa trong hàng đợi  (mặc định 100)
"""

import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

# handler.py nằm ở / trong image (Dockerfile: COPY src/handler.py /handler.py).
# Thêm cả thư mục của chính file này để chạy được từ repo lúc dev.
for _p in ("/", os.path.dirname(os.path.abspath(__file__))):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import handler as H  # noqa: E402  — phải sau khi vá sys.path

PORT = int(os.environ.get("POD_PORT", "8000"))
API_KEY = os.environ.get("POD_API_KEY", "").strip()
CONCURRENCY = max(1, int(os.environ.get("POD_CONCURRENCY", "1")))
JOB_TTL_SEC = int(os.environ.get("POD_JOB_TTL_SEC", "86400"))
QUEUE_MAX = int(os.environ.get("POD_QUEUE_MAX", "100"))

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}


def log(msg: str) -> None:
    print(f"[pod-server] {msg}", flush=True)


# --------------------------------------------------------------------------
# Kho job trong RAM
# --------------------------------------------------------------------------
# Cố ý KHÔNG persist ra đĩa. Pod restart là ComfyUI mất luôn tiến trình đang
# chạy, nên job dở dang có ghi lại cũng không cứu được. Phía backend đã có sẵn
# lưới an toàn: `poller.js` chốt FAILED + hoàn credit cho request treo quá
# POLLER_MAX_AGE_MS. Việc cần làm là để lỗi lộ ra nhanh, không phải giả vờ bền.
_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_work: "queue.Queue[str]" = queue.Queue()

# Idempotency-Key → job_id.
#
# VÌ SAO CẦN: `POST /run` không idempotent, mà client thì CÓ retry (proxy của
# RunPod trả 502/503 lúc Pod bận hoặc mạng chớp). Retry một POST đã tới nơi =
# job trùng. Ngày 22/08/2026 một lượt bench 4 cấu hình đẻ ra 6 job; hai job thừa
# gửi đúng workflow vừa chạy xong → ComfyUI trả về từ CACHE
# ("Prompt executed in 0.00 seconds"), `outputs` rỗng, và handler báo nhầm là
# "SaveVideo bị mute". Tốn GPU thì không, nhưng làm hỏng bảng đo và mất 20 phút
# đi tìm một lỗi không tồn tại.
_idem: Dict[str, str] = {}


def _new_job(payload: Dict[str, Any], webhook: Optional[str]) -> Dict[str, Any]:
    job_id = f"pod-{uuid.uuid4().hex}"
    job = {
        "id": job_id,
        "status": "IN_QUEUE",
        "input": payload.get("input") or {},
        "webhook": webhook,
        "output": None,
        "error": None,
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "cancel": threading.Event(),
        "prompt_id": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    return job


def _public_view(job: Dict[str, Any]) -> Dict[str, Any]:
    """Đúng hình dạng GET /status/{id} của RunPod — webhook cũng gửi dạng này."""
    started = job.get("started_at") or job.get("finished_at") or time.time()
    view = {
        "id": job["id"],
        "status": job["status"],
        "delayTime": int((started - job["created_at"]) * 1000),
        "workerId": "pod",
    }
    if job.get("started_at"):
        end = job.get("finished_at") or time.time()
        view["executionTime"] = int((end - job["started_at"]) * 1000)
    if job.get("output") is not None:
        view["output"] = job["output"]
    if job.get("error"):
        view["error"] = job["error"]
    return view


def _evict_old() -> None:
    cutoff = time.time() - JOB_TTL_SEC
    with _jobs_lock:
        for jid in [
            j for j, v in _jobs.items()
            if v["status"] in TERMINAL and (v.get("finished_at") or 0) < cutoff
        ]:
            _jobs.pop(jid, None)


# --------------------------------------------------------------------------
# Webhook
# --------------------------------------------------------------------------
def _fire_webhook(job: Dict[str, Any]) -> None:
    """
    Gửi kết quả về backend. Thử 3 lần rồi thôi — poller.js là lưới thứ hai,
    nên retry vô hạn ở đây chỉ tổ giữ thread và làm log rối.
    """
    url = job.get("webhook")
    if not url:
        return
    body = _public_view(job)
    for attempt in range(3):
        try:
            r = httpx.post(url, json=body, timeout=20)
            if r.status_code < 400:
                log(f"webhook {job['id']} → {r.status_code}")
                return
            log(f"webhook {job['id']} lần {attempt + 1}: HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001
            log(f"webhook {job['id']} lần {attempt + 1} lỗi: {e}")
        time.sleep(2 * (attempt + 1))
    log(f"webhook {job['id']} THẤT BẠI sau 3 lần — poller sẽ nhặt lại.")


# --------------------------------------------------------------------------
# Vòng poll ComfyUI (bản không phụ thuộc runpod SDK)
# --------------------------------------------------------------------------
def _poll_until_done(job: Dict[str, Any], prompt_id: str) -> Dict[str, Any]:
    start_ts = time.time()
    deadline = start_ts + H.MAX_WAIT_SEC
    last_report = 0.0

    with httpx.Client(timeout=30) as c:
        while time.time() < deadline:
            if job["cancel"].is_set():
                try:
                    c.post(f"{H.COMFY_URL}/interrupt")
                except Exception:  # noqa: BLE001
                    pass
                raise _Cancelled()

            h = c.get(f"{H.COMFY_URL}/history/{prompt_id}")
            if h.status_code == 200:
                data = h.json()
                if prompt_id in data:
                    entry = data[prompt_id]
                    status = entry.get("status", {})
                    if status.get("completed") or status.get("status_str") == "success":
                        return entry
                    if status.get("status_str") == "error":
                        raise RuntimeError(H._format_comfy_error(status))

            now = time.time()
            if now - last_report > 5:
                last_report = now
                try:
                    q = c.get(f"{H.COMFY_URL}/queue").json()
                    running = len(q.get("queue_running", []))
                    # Backend đọc được cái này qua GET /status/{id} khi job đang chạy —
                    # giống hệt progress_update của RunPod.
                    job["output"] = {
                        "state": "running" if running else "queued",
                        "pending": len(q.get("queue_pending", [])),
                        "elapsedSec": int(now - start_ts),
                    }
                except Exception:  # noqa: BLE001
                    pass

            time.sleep(H.POLL_INTERVAL)

    raise TimeoutError(
        f"Job vượt quá {H.MAX_WAIT_SEC}s. Tăng COMFY_MAX_WAIT_SEC, hoặc giảm "
        "resolution / số frame / số bước."
    )


class _Cancelled(Exception):
    pass


# --------------------------------------------------------------------------
# Worker
# --------------------------------------------------------------------------
def _run_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """Bản Pod của handler.handler() — cùng input/output schema."""
    t0 = time.time()
    warnings = []
    inp = job["input"]

    workflow = inp.get("workflow")
    if not isinstance(workflow, dict) or not workflow:
        raise ValueError("input.workflow bắt buộc và phải là object workflow API của ComfyUI")

    meta = inp.get("meta") or {}
    prefix = str(inp.get("output_prefix") or "videos").strip("/")

    H.stage_assets(inp.get("assets") or [], warnings)

    t_queue = time.time()
    prompt_id = H.queue_prompt(workflow, str(uuid.uuid4()))
    job["prompt_id"] = prompt_id
    log(f"{job['id']} → prompt {prompt_id}")

    entry = _poll_until_done(job, prompt_id)
    t_exec = time.time()

    files = H.collect_outputs(entry, warnings)
    if not files:
        # Phân biệt hai nguyên nhân rất khác nhau nhưng triệu chứng giống hệt.
        # ComfyUI cache theo nội dung node: gửi lại ĐÚNG workflow vừa chạy thì
        # không node nào chạy lại, `outputs` rỗng và log ghi
        # "Prompt executed in 0.00 seconds". Báo "SaveVideo bị mute" ở đây là
        # chỉ sai đường — đã mất công đi tìm một lỗi không tồn tại (22/08/2026).
        if (time.time() - t_queue) < 5:
            raise RuntimeError(
                "ComfyUI trả kết quả từ CACHE (không node nào chạy lại) nên không có "
                "file mới. Gần như chắc chắn đây là job TRÙNG — cùng workflow với job "
                "vừa chạy xong. Kiểm tra client có gửi lặp không, và dùng header "
                "Idempotency-Key để retry không đẻ job mới."
            )
        raise RuntimeError(
            "Workflow chạy xong nhưng không sinh ra file output nào. "
            "Kiểm tra node SaveVideo có bị mute không."
        )

    uploaded = []
    for p in files:
        uploaded.append(H.upload_to_r2(p, f"{prefix}/{job['id']}/{p.name}"))
        log(f"{job['id']} upload {p.name}")
    t_upload = time.time()

    H.cleanup(files)
    videos, images, audios = H.bucketize(uploaded)
    if not videos:
        warnings.append("Không có file video nào trong output.")

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


def _worker_loop(idx: int) -> None:
    log(f"worker #{idx} sẵn sàng")
    while True:
        job_id = _work.get()
        job = _jobs.get(job_id)
        if job is None:
            _work.task_done()
            continue

        if job["cancel"].is_set():
            job.update(status="CANCELLED", finished_at=time.time())
            _fire_webhook(job)
            _work.task_done()
            continue

        job.update(status="IN_PROGRESS", started_at=time.time(), output=None)
        try:
            out = _run_job(job)
            job.update(status="COMPLETED", output=out, finished_at=time.time())
            t = out["timings"]
            log(f"{job_id} XONG · execute {t['executeMs']}ms · upload {t['uploadMs']}ms")
        except _Cancelled:
            job.update(status="CANCELLED", output=None, finished_at=time.time())
            log(f"{job_id} đã huỷ")
        except Exception as e:  # noqa: BLE001
            # In traceback đầy đủ ra log Pod, chỉ trả message cho backend.
            traceback.print_exc()
            job.update(
                status="FAILED",
                output=None,
                error=f"{type(e).__name__}: {e}",
                finished_at=time.time(),
            )
            log(f"{job_id} HỎNG: {e}")

        _fire_webhook(job)
        _evict_old()
        _work.task_done()


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Api(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "h3-pod/1.0"

    # BaseHTTPRequestHandler mặc định ghi mỗi request ra stderr theo định dạng
    # apache — với poller hỏi mỗi giây thì log Pod thành rác.
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    # ---- tiện ích ---------------------------------------------------------
    def _send(self, code: int, body: Any) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authed(self) -> bool:
        if not API_KEY:
            return True
        got = self.headers.get("Authorization", "")
        return got.startswith("Bearer ") and got[7:].strip() == API_KEY

    def _body(self) -> Dict[str, Any]:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # ---- routes -----------------------------------------------------------
    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"

        if path == "/ping":  # không cần auth — dùng cho health check hạ tầng
            return self._send(200, {"ok": True})

        if not self._authed():
            return self._send(401, {"error": "unauthorized"})

        if path == "/health":
            with _jobs_lock:
                vals = list(_jobs.values())
            counts = {
                "inQueue": sum(1 for j in vals if j["status"] == "IN_QUEUE"),
                "inProgress": sum(1 for j in vals if j["status"] == "IN_PROGRESS"),
                "completed": sum(1 for j in vals if j["status"] == "COMPLETED"),
                "failed": sum(1 for j in vals if j["status"] in ("FAILED", "TIMED_OUT")),
            }
            comfy_ok, comfy_info = _comfy_probe()
            return self._send(200, {
                "jobs": counts,
                "workers": {
                    "ready": CONCURRENCY if comfy_ok else 0,
                    "running": counts["inProgress"],
                    "idle": max(0, CONCURRENCY - counts["inProgress"]),
                },
                "comfy": comfy_info,
            })

        if path.startswith("/models/"):
            # Liệt kê weights mà ComfyUI THẬT SỰ nhìn thấy trên volume.
            #
            # Vì sao đáng có: sai tên file LoRA hay quên tải weights lên volume
            # chỉ lộ ra sau khi job chạy — và trên Pod thì đó là tiền GPU thật.
            # Hỏi ComfyUI trước khi gửi job tốn 200ms.
            #   /models/loras            → tên các LoRA
            #   /models/diffusion_models → tên các unet
            kind = path.split("/models/", 1)[1]
            NODES = {
                "loras": ("LoraLoaderModelOnly", "lora_name"),
                "diffusion_models": ("UNETLoader", "unet_name"),
                "text_encoders": ("CLIPLoader", "clip_name"),
                "vae": ("VAELoader", "vae_name"),
            }
            if kind not in NODES:
                return self._send(400, {"error": f"kind phải là một trong {list(NODES)}"})
            node, field = NODES[kind]
            try:
                r = httpx.get(f"{H.COMFY_URL}/object_info/{node}", timeout=20)
                info = r.json()[node]["input"]["required"][field][0]
                return self._send(200, {"kind": kind, "node": node, "items": info})
            except Exception as e:  # noqa: BLE001
                return self._send(502, {"error": f"không đọc được /object_info/{node}: {e}"})

        if path.startswith("/status/"):
            job = _jobs.get(path.split("/status/", 1)[1])
            if not job:
                # Backend coi đây là "không hỏi được" và thử lại vòng sau; đến
                # POLLER_MAX_AGE_MS thì tự chốt FAILED + hoàn credit.
                return self._send(404, {"error": "job không tồn tại hoặc đã hết hạn lưu"})
            return self._send(200, _public_view(job))

        return self._send(404, {"error": f"không có route GET {path}"})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"

        if not self._authed():
            return self._send(401, {"error": "unauthorized"})

        try:
            body = self._body()
        except json.JSONDecodeError as e:
            return self._send(400, {"error": f"body không phải JSON hợp lệ: {e}"})

        if path in ("/run", "/runsync"):
            # Gửi lại cùng một Idempotency-Key = cùng một job, không đẻ job mới.
            # Client sinh key mỗi lần THỰC SỰ muốn chạy; retry thì giữ nguyên key.
            idem = (self.headers.get("Idempotency-Key") or "").strip()
            if idem:
                with _jobs_lock:
                    prev = _idem.get(idem)
                if prev and prev in _jobs:
                    log(f"idempotent: {idem[:12]}… → {prev} (không tạo job mới)")
                    return self._send(200, {"id": prev, "status": _jobs[prev]["status"]})

            if _work.qsize() >= QUEUE_MAX:
                # 503 chứ không phải nhận rồi chết sau: backend biết ngay để
                # hoàn credit và báo user thử lại.
                return self._send(503, {"error": f"hàng đợi đầy ({QUEUE_MAX} job)"})

            job = _new_job(body, body.get("webhook"))
            if idem:
                with _jobs_lock:
                    _idem[idem] = job["id"]
            _work.put(job["id"])
            log(f"nhận {job['id']} (đợi {_work.qsize()})")

            if path == "/run":
                return self._send(200, {"id": job["id"], "status": "IN_QUEUE"})

            # /runsync: chờ tối đa 15 phút rồi trả về trạng thái hiện tại.
            deadline = time.time() + 900
            while time.time() < deadline and job["status"] not in TERMINAL:
                time.sleep(1)
            return self._send(200, _public_view(job))

        if path.startswith("/cancel/"):
            job = _jobs.get(path.split("/cancel/", 1)[1])
            if not job:
                return self._send(404, {"error": "job không tồn tại"})
            if job["status"] in TERMINAL:
                return self._send(200, _public_view(job))
            job["cancel"].set()
            return self._send(200, {"id": job["id"], "status": "CANCELLED"})

        return self._send(404, {"error": f"không có route POST {path}"})


def _comfy_probe():
    try:
        r = httpx.get(f"{H.COMFY_URL}/system_stats", timeout=5)
        if r.status_code == 200:
            return True, {"ok": True, "report": H._gpu_report(r.json())}
        return False, {"ok": False, "http": r.status_code}
    except Exception as e:  # noqa: BLE001
        return False, {"ok": False, "error": str(e)}


def main() -> None:
    if not API_KEY:
        log("⚠ POD_API_KEY TRỐNG — cổng proxy của Pod là công khai trên Internet, "
            "ai biết URL cũng gửi job được. Đặt POD_API_KEY trước khi chạy thật.")

    # Chờ ComfyUI TRƯỚC khi mở cổng: mở cổng sớm thì backend gửi job vào rồi
    # mới phát hiện ComfyUI chết, và job đó mất oan.
    H.wait_for_comfy(timeout_sec=int(os.environ.get("POD_COMFY_WAIT_SEC", "900")))

    for i in range(CONCURRENCY):
        threading.Thread(target=_worker_loop, args=(i + 1,), daemon=True).start()

    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Api)
    srv.daemon_threads = True
    log(f"lắng nghe :{PORT} · concurrency={CONCURRENCY} · auth={'BẬT' if API_KEY else 'TẮT'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("dừng.")


if __name__ == "__main__":
    main()
