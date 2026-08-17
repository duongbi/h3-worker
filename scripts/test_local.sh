#!/usr/bin/env bash
# =============================================================================
#  Test worker ở local trước khi deploy — tiết kiệm rất nhiều tiền GPU
#
#  Chạy trên máy/Pod CÓ GPU và CÓ sẵn weights.
#  worker-comfyui hỗ trợ SERVE_API_LOCALLY=true → dựng một HTTP server
#  giả lập API RunPod tại http://localhost:8000
# =============================================================================
set -euo pipefail

IMAGE="${IMAGE:-h3-worker:dev}"
MODELS_DIR="${MODELS_DIR:-$HOME/h3-models}"   # thư mục chứa ComfyUI/models/...
PORT="${PORT:-8000}"

if [[ ! -f .env ]]; then
  echo "!! Chưa có .env — copy từ .env.example và điền thông tin R2." >&2
  exit 1
fi

echo "==> Build image"
docker build -t "${IMAGE}" .

echo "==> Chạy container (Ctrl-C để dừng)"
echo "    ComfyUI  : http://localhost:8188"
echo "    Worker API: http://localhost:${PORT}"
echo
echo "    Cold start sẽ mất vài phút để nạp ~32GB weights. Kiên nhẫn."
echo

docker run --rm -it \
  --gpus all \
  --env-file .env \
  -e SERVE_API_LOCALLY=true \
  -e COMFY_MAX_WAIT_SEC=1800 \
  -v "${MODELS_DIR}:/runpod-volume" \
  -p "${PORT}:8000" \
  -p 8188:8188 \
  "${IMAGE}"

# Ở terminal khác:
#   bash scripts/curl_examples.sh local
