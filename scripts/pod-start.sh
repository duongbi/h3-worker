#!/usr/bin/env bash
# =============================================================================
#  Khởi động h3-worker ở chế độ POD (thay cho /start.sh của Serverless).
#
#  Dùng CHÍNH image ghcr.io/duongbi/h3-worker đang chạy trên Serverless — chỉ
#  đổi lệnh khởi động. Không build image riêng cho Pod: hai image sẽ lệch nhau
#  sau vài tuần và mọi số đo so sánh giữa Pod với Serverless thành vô nghĩa.
#
#  Đặt ở RunPod → Pod → Container Start Command:
#      bash -c "curl -fsSL <raw-url>/pod-start.sh -o /pod-start.sh && bash /pod-start.sh"
#  hoặc COPY sẵn vào image rồi chỉ cần:  bash /pod-start.sh
# =============================================================================
set -euo pipefail

log() { echo "[pod-start] $*"; }

# ---- Volume ---------------------------------------------------------------
# extra_model_paths.yaml trong image trỏ cứng vào /runpod-volume/ComfyUI/models.
# Trên Pod, RunPod mount network volume theo "Volume Mount Path" bạn khai trong
# form tạo Pod — mặc định là /workspace. Nếu bạn để mặc định thì tạo symlink,
# đỡ phải sửa image.
if [ ! -d /runpod-volume ] && [ -d /workspace/ComfyUI/models ]; then
    log "Không thấy /runpod-volume nhưng /workspace có models → tạo symlink."
    ln -sfn /workspace /runpod-volume
fi

if [ ! -d /runpod-volume/ComfyUI/models/diffusion_models ]; then
    log "!! /runpod-volume/ComfyUI/models/diffusion_models KHÔNG tồn tại."
    log "!! Network volume chưa gắn, hoặc Volume Mount Path sai."
    log "!! Nội dung /runpod-volume:"; ls -la /runpod-volume 2>/dev/null || true
    log "!! Nội dung /workspace:";     ls -la /workspace     2>/dev/null || true
    exit 1
fi
log "Weights: $(ls -1 /runpod-volume/ComfyUI/models/diffusion_models/*.safetensors 2>/dev/null | wc -l) file."

# ---- Biến bắt buộc --------------------------------------------------------
# Thiếu biến R2 thì job vẫn sampling xong 5 phút rồi mới chết lúc upload —
# đúng cái bẫy đã dính trên Serverless. Chặn ngay từ lúc khởi động.
missing=()
for v in R2_BUCKET R2_ENDPOINT_URL R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
    log "!! Thiếu biến môi trường: ${missing[*]}"
    log "!! Đặt ở RunPod → Pod → Edit → Environment Variables."
    exit 1
fi
[ -n "${POD_API_KEY:-}" ] || log "⚠ POD_API_KEY trống — cổng proxy của Pod là công khai."

# ---- Driver của máy vs bản build của torch --------------------------------
# torch cu130 đòi driver Linux >= 580.65.06. Máy RunPod còn r570/r575 sẽ chết
# với "The NVIDIA driver on your system is too old (found version 12080)".
# Thông báo đó chỉ sai đường ("liên hệ RunPod support") — thực ra chỉ là bốc
# trúng máy cũ. In rõ ở đây để khỏi mất một vòng debug. Đã dính 22/08/2026.
DRV="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || true)"
TORCH_CUDA="$(python -c 'import torch;print(torch.version.cuda or "")' 2>/dev/null || true)"
log "driver=${DRV:-không đọc được} · torch build cho CUDA ${TORCH_CUDA:-?}"

case "$TORCH_CUDA" in
  13*)
    DRV_MAJOR="${DRV%%.*}"
    if [ -n "$DRV_MAJOR" ] && [ "$DRV_MAJOR" -lt 580 ] 2>/dev/null; then
        log "!! KHÔNG TƯƠNG THÍCH: torch build cho CUDA 13 nhưng driver $DRV < 580.65.06."
        log "!! Máy này không chạy được image cu130. KHÔNG phải máy hỏng, đừng báo support."
        log "!!"
        log "!! Sửa cách 1 (nên làm): xoá Pod, deploy lại, mở Filters ở trang deploy và"
        log "!!   chọn CUDA Versions = 13.0. Serverless của bạn vẫn chạy cu130 bình thường"
        log "!!   nên DC này CÓ máy đủ driver — lần này chỉ là bốc trúng máy cũ."
        log "!! Sửa cách 2 (khi DC hết máy CUDA 13.0): build ảnh dự phòng cu128 ở"
        log "!!   GitHub → Actions → Build & Deploy h3-worker → Run workflow →"
        log "!!   torch_channel = cu128, rồi dùng image tag <sha>-cu128. CHẬM HƠN cu130."
        exit 1
    fi
    ;;
esac

# ---- ComfyUI-Manager: tắt tải registry lúc khởi động ----------------------
# Triệu chứng: hàng trăm dòng "FETCH ComfyRegistry Data: n/176" mỗi lần boot,
# kéo dài hàng chục giây GPU trả tiền, và treo hẳn nếu api.comfy.org chậm.
#
# `/start.sh` của base image CÓ đặt offline, nhưng ghi vào đường dẫn CŨ
# `user/default/ComfyUI-Manager/config.ini`. ComfyUI 0.33.0 của ta lại đọc
# `user/__manager/config.ini` (System User API, từ 0.3.76+) — chính ComfyUI in
# đường dẫn đó ra lúc khởi động. Nên offline chưa bao giờ ăn, kể cả trên
# Serverless. Ghi vào CẢ HAI cho chắc, bất kể phiên bản.
#
# network_mode chỉ đọc được từ config.ini — không có env var, không có cờ CLI.
# Workflow của ta chỉ dùng node core nên không cần Manager online bao giờ.
# Cần cài node qua Manager thì đặt COMFY_MANAGER_NETWORK_MODE=public.
MANAGER_MODE="${COMFY_MANAGER_NETWORK_MODE:-offline}"
python - "$MANAGER_MODE" <<'PY' || log "⚠ không đặt được network_mode cho ComfyUI-Manager (bỏ qua)"
import configparser, os, sys
mode = sys.argv[1]
for path in ("/comfyui/user/__manager/config.ini",
             "/comfyui/user/default/ComfyUI-Manager/config.ini"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cp = configparser.ConfigParser()
    cp.read(path)                       # file chưa có thì đọc rỗng, không lỗi
    if not cp.has_section("default"):
        cp.add_section("default")
    cp.set("default", "network_mode", mode)
    with open(path, "w") as f:
        cp.write(f)
    print(f"[pod-start] ComfyUI-Manager network_mode={mode} → {path}", flush=True)
PY

# ---- ComfyUI --------------------------------------------------------------
# --highvram: Pod sống lâu, giữ weights thường trú là mục đích chính của việc
#   đổi sang Pod. Card 32GB không đủ chỗ thì BỎ cờ này (aimdo tự xoay), card
#   96GB thì bật để không stream lại gì giữa các job.
COMFY_ARGS="${COMFY_ARGS:---listen 0.0.0.0 --port 8188}"
if [ "${COMFY_SAGE_ATTENTION:-0}" = "1" ]; then
    COMFY_ARGS="$COMFY_ARGS --use-sage-attention"
    log "SageAttention: BẬT"
fi

log "ComfyUI: python -u /comfyui/main.py $COMFY_ARGS"
# shellcheck disable=SC2086
python -u /comfyui/main.py $COMFY_ARGS &
COMFY_PID=$!

# Kéo theo nhau: ComfyUI chết mà pod_server còn sống thì Pod trông vẫn "khoẻ"
# trong khi mọi job đều hỏng — kiểu lỗi tốn nhiều thời gian nhất để lần ra.
trap 'kill $COMFY_PID 2>/dev/null || true' EXIT

export COMFY_HOST="${COMFY_HOST:-127.0.0.1:8188}"
log "pod_server trên cổng ${POD_PORT:-8000}"
python -u /pod_server.py
