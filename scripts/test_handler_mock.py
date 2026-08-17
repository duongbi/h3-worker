"""
Test handler.py end-to-end với ComfyUI giả lập + R2 giả lập.

KHÔNG CẦN GPU, KHÔNG CẦN WEIGHTS, KHÔNG CẦN CREDENTIAL — chạy trong ~2 giây.
Chạy cái này mỗi lần bạn sửa handler.py, trước khi build image.

    pip install runpod httpx
    python scripts/test_handler_mock.py

Phủ 6 tình huống: happy path (video+audio, bỏ preview temp, cảnh báo file
thiếu, dọn đĩa), thiếu workflow, key ngoài schema, lỗi node của ComfyUI,
workflow không sinh file, và path traversal trong tên asset.
"""
import json, os, sys, threading, time, shutil
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OUT = Path("/tmp/mock_output"); OUT.mkdir(exist_ok=True)
INP = Path("/tmp/mock_input"); INP.mkdir(exist_ok=True)
os.environ.update({
    "COMFY_HOST": "127.0.0.1:8899",
    "OUTPUT_DIR": str(OUT), "INPUT_DIR": str(INP),
    "COMFY_POLL_INTERVAL_MS": "100", "COMFY_MAX_WAIT_SEC": "20",
    "R2_BUCKET": "x", "R2_ENDPOINT_URL": "http://x", "R2_ACCESS_KEY_ID": "x",
    "R2_SECRET_ACCESS_KEY": "x", "R2_PUBLIC_BASE_URL": "https://cdn.test",
})

STATE = {"polls": 0, "fail": False}

class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/system_stats": return self._j(200, {"system": {}})
        if self.path == "/queue": return self._j(200, {"queue_pending": [], "queue_running": [1]})
        if self.path.startswith("/history/"):
            STATE["polls"] += 1
            if STATE["polls"] < 3: return self._j(200, {})
            if STATE["fail"]:
                return self._j(200, {"pid1": {"status": {"status_str": "error", "messages": [
                    ["execution_error", {"node_id": "42", "node_type": "VHS_VideoCombine",
                     "exception_type": "RuntimeError", "exception_message": "CUDA OOM"}]]}}})
            return self._j(200, {"pid1": {"status": {"status_str": "success", "completed": True},
                "outputs": {
                  "9":  {"images": [{"filename": "prev.png", "subfolder": "", "type": "temp"}]},
                  "42": {"gifs":   [{"filename": "H3_00001.mp4", "subfolder": "", "type": "output"}]},
                  "43": {"audio":  [{"filename": "H3_00001.wav", "subfolder": "sub", "type": "output"}]},
                  "44": {"images": [{"filename": "missing.png", "subfolder": "", "type": "output"}]},
                }}})
        self._j(404, {})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/prompt":
            if not body.get("prompt"): return self._j(400, {"error": "empty", "node_errors": {}})
            return self._j(200, {"prompt_id": "pid1"})
        self._j(404, {})

srv = HTTPServer(("127.0.0.1", 8899), Mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import handler as H

uploads = []
def fake_upload(path, key):
    uploads.append(key)
    return {"url": f"https://cdn.test/{key}", "key": key, "filename": path.name,
            "sizeBytes": path.stat().st_size, "contentType": "video/mp4"}
H.upload_to_r2 = fake_upload

def seed_files():
    (OUT / "H3_00001.mp4").write_bytes(b"\x00" * 1234)
    (OUT / "sub").mkdir(exist_ok=True)
    (OUT / "sub" / "H3_00001.wav").write_bytes(b"\x00" * 99)
    (OUT / "prev.png").write_bytes(b"\x00" * 5)

# ---- Case 1: happy path -------------------------------------------------
seed_files()
job = {"id": "job-abc", "input": {"workflow": {"1": {"class_type": "K"}},
       "meta": {"jobId": "u-1"}, "output_prefix": "videos/2026"}}
r = H.handler(job)
assert "error" not in r, r
assert len(r["videos"]) == 1 and r["videos"][0]["filename"] == "H3_00001.mp4", r
assert len(r["audios"]) == 1, r
assert r["images"] == [], "preview temp phải bị bỏ qua"
assert any("missing.png" in w for w in r["warnings"]), r["warnings"]
assert r["meta"] == {"jobId": "u-1"}
assert uploads[0].startswith("videos/2026/job-abc/")
assert not (OUT / "H3_00001.mp4").exists(), "phải xoá file sau upload"
assert (OUT / "prev.png").exists(), "file temp không bị đụng vào"
print("✓ case 1: happy path — video+audio, bỏ temp, cảnh báo file thiếu, dọn đĩa")

# ---- Case 2: thiếu workflow --------------------------------------------
r = H.handler({"id": "j2", "input": {"meta": {}}})
assert "error" in r and "workflow" in str(r["error"]), r
print("✓ case 2: thiếu workflow → lỗi validate")

# ---- Case 3: key lạ trong input ----------------------------------------
r = H.handler({"id": "j3", "input": {"workflow": {"1": {}}, "bogus": 1}})
assert "error" in r, r
print("✓ case 3: key ngoài schema bị chặn")

# ---- Case 4: ComfyUI execution error ------------------------------------
STATE.update(polls=0, fail=True)
try:
    H.handler({"id": "j4", "input": {"workflow": {"1": {}}}})
    raise AssertionError("phải raise")
except RuntimeError as e:
    assert "CUDA OOM" in str(e) and "VHS_VideoCombine" in str(e), e
    print("✓ case 4: lỗi node được surface đầy đủ:", str(e)[:80])

# ---- Case 5: không có file output ---------------------------------------
STATE.update(polls=0, fail=False)
shutil.rmtree(OUT); OUT.mkdir()
r = H.handler({"id": "j5", "input": {"workflow": {"1": {}}}})
assert "error" in r and "output" in r["error"], r
print("✓ case 5: workflow không sinh file → lỗi có hướng dẫn")

# ---- Case 6: path traversal trong asset name ----------------------------
seed_files(); STATE["polls"] = 0
import base64
r = H.handler({"id": "j6", "input": {"workflow": {"1": {}}, "assets": [
    {"name": "../../etc/evil.png", "base64": base64.b64encode(b"x").decode()}]}})
assert (INP / "evil.png").exists(), "phải strip path"
assert not Path("/etc/evil.png").exists()
print("✓ case 6: chặn path traversal trong tên asset")

print("\nTẤT CẢ TEST PASS")
