#!/usr/bin/env python3
"""
Tạo Template + Serverless Endpoint trên RunPod bằng REST API v1.

Chạy MỘT LẦN, sau khi image đã có trên ghcr.io và network volume đã có weights.
Các lần deploy sau chỉ cần đổi image → dùng scripts/runpod_deploy.sh.

    export RUNPOD_API_KEY=rpa_xxx
    set -a; source .env; set +a          # nạp biến R2_*
    python scripts/runpod_setup.py --image ghcr.io/user/h3-worker:abc1234

Xem trước mà không tạo gì:
    python scripts/runpod_setup.py --image ... --dry-run

Chỉ liệt kê tài nguyên đang có:
    python scripts/runpod_setup.py --list
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://rest.runpod.io/v1"

# Các biến môi trường worker cần — đọc từ shell hiện tại (sau khi source .env)
ENV_KEYS = [
    "R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
    "R2_PUBLIC_BASE_URL", "R2_PRESIGN_EXPIRY_SEC",
    "COMFY_HOST", "COMFY_POLL_INTERVAL_MS", "COMFY_MAX_WAIT_SEC",
    "OUTPUT_DIR", "INPUT_DIR",
]
REQUIRED_ENV = ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]


def req(method: str, path: str, body=None, key: str = ""):
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", f"Bearer {key}")
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:1500]
        raise SystemExit(f"✗ {method} {path} → HTTP {e.code}\n{detail}")
    except urllib.error.URLError as e:
        raise SystemExit(f"✗ Không kết nối được RunPod API: {e}")


def show_resources(key: str):
    print("── Network volumes ─────────────────────────────────────────")
    vols = req("GET", "/networkvolumes", key=key)
    vols = vols if isinstance(vols, list) else vols.get("data", [])
    if not vols:
        print("  (chưa có) — tạo ở console hoặc POST /v1/networkvolumes")
    for v in vols:
        print(f"  {v.get('id'):<24} {v.get('name','')!r:<28} "
              f"{v.get('size')}GB  DC={v.get('dataCenterId')}")

    print("\n── Templates ───────────────────────────────────────────────")
    tpls = req("GET", "/templates", key=key)
    tpls = tpls if isinstance(tpls, list) else tpls.get("data", [])
    for t in tpls[:20]:
        print(f"  {t.get('id'):<24} {t.get('name','')!r:<28} {t.get('imageName','')}")

    print("\n── Endpoints ───────────────────────────────────────────────")
    eps = req("GET", "/endpoints", key=key)
    eps = eps if isinstance(eps, list) else eps.get("data", [])
    for e in eps[:20]:
        print(f"  {e.get('id'):<24} {e.get('name','')!r:<28} "
              f"tpl={e.get('templateId')}  max={e.get('workersMax')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", help="ghcr.io/user/h3-worker:tag")
    ap.add_argument("--name", default="h3-worker")
    ap.add_argument("--volume-id", help="ID network volume chứa weights")
    ap.add_argument("--gpu", action="append", default=[],
                    help="GPU type ID, lặp lại được. VD: --gpu 'NVIDIA GeForce RTX 5090'")
    ap.add_argument("--workers-min", type=int, default=0)
    ap.add_argument("--workers-max", type=int, default=3)
    ap.add_argument("--idle-timeout", type=int, default=90, help="giây")
    ap.add_argument("--execution-timeout", type=int, default=900, help="giây")
    ap.add_argument("--container-disk", type=int, default=30, help="GB")
    ap.add_argument("--list", action="store_true", help="chỉ liệt kê tài nguyên rồi thoát")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = os.environ.get("RUNPOD_API_KEY", "")
    if not key:
        print("✗ Chưa set RUNPOD_API_KEY")
        return 1

    if args.list:
        show_resources(key)
        return 0

    if not args.image:
        print("✗ Thiếu --image")
        return 1

    missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        print(f"✗ Thiếu biến môi trường: {', '.join(missing)}")
        print("  Chạy:  set -a; source .env; set +a")
        return 1

    env = {k: os.environ[k] for k in ENV_KEYS if os.environ.get(k)}

    # -- Network volume ------------------------------------------------------
    volume_id = args.volume_id
    if not volume_id:
        vols = req("GET", "/networkvolumes", key=key)
        vols = vols if isinstance(vols, list) else vols.get("data", [])
        if len(vols) == 1:
            volume_id = vols[0]["id"]
            print(f"ℹ  Dùng network volume duy nhất đang có: {volume_id} "
                  f"({vols[0].get('name')}, {vols[0].get('size')}GB, "
                  f"DC={vols[0].get('dataCenterId')})")
        else:
            print("✗ Cần --volume-id. Các volume đang có:")
            for v in vols:
                print(f"   {v.get('id')}  {v.get('name')}  {v.get('size')}GB  "
                      f"DC={v.get('dataCenterId')}")
            return 1

    if not args.gpu:
        print("✗ Cần ít nhất một --gpu. Lấy đúng tên ở RunPod console khi tạo endpoint.")
        print("  Gợi ý: --gpu 'NVIDIA GeForce RTX 5090' --gpu 'NVIDIA L40S'")
        print("  Chọn nhiều loại để tăng khả năng bắt được máy trống.")
        return 1

    template_body = {
        "name": f"{args.name}-tpl",
        "imageName": args.image,
        "isServerless": True,
        "containerDiskInGb": args.container_disk,
        "env": env,
    }
    endpoint_body = {
        "name": args.name,
        "computeType": "GPU",
        "gpuTypeIds": args.gpu,
        "networkVolumeId": volume_id,
        "workersMin": args.workers_min,
        "workersMax": args.workers_max,
        "idleTimeout": args.idle_timeout,
        "executionTimeoutMs": args.execution_timeout * 1000,
        "flashboot": True,
        "scalerType": "QUEUE_DELAY",
    }

    redacted = dict(template_body)
    redacted["env"] = {k: ("***" if "SECRET" in k or "ACCESS_KEY" in k else v)
                       for k, v in env.items()}
    print("\n── Template sẽ tạo ─────────────────────────────────────────")
    print(json.dumps(redacted, indent=2, ensure_ascii=False))
    print("\n── Endpoint sẽ tạo ─────────────────────────────────────────")
    print(json.dumps(endpoint_body, indent=2, ensure_ascii=False))

    if args.dry_run:
        print("\n(dry-run — chưa tạo gì)")
        return 0

    print("\n==> Tạo template…")
    tpl = req("POST", "/templates", template_body, key)
    tpl_id = tpl["id"]
    print(f"   ✓ templateId = {tpl_id}")

    print("==> Tạo endpoint…")
    endpoint_body["templateId"] = tpl_id
    ep = req("POST", "/endpoints", endpoint_body, key)
    ep_id = ep["id"]
    print(f"   ✓ endpointId = {ep_id}")

    print(f"""
─────────────────────────────────────────────────────────────
✓ Xong.

Thêm vào GitHub → Settings → Secrets and variables → Actions:
    RUNPOD_API_KEY       = (API key của bạn)
    RUNPOD_TEMPLATE_ID   = {tpl_id}

Thêm vào .env của backend:
    RUNPOD_ENDPOINT_ID   = {ep_id}

Gọi thử:
    curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" \\
      https://api.runpod.ai/v2/{ep_id}/health | jq .

Từ giờ mỗi lần push lên main, GitHub Actions sẽ build và tự PATCH template
sang image mới — không cần chạy lại script này.
─────────────────────────────────────────────────────────────""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
