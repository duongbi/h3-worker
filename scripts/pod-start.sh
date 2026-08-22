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
