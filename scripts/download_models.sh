#!/usr/bin/env bash
# =============================================================================
#  Tải weights MiniMax-H3 vào RunPod Network Volume
#
#  CHẠY Ở ĐÂU: trên một Pod on-demand tạm thời (không phải serverless),
#  cùng datacenter với network volume, volume mount tại /workspace.
#
#  Sau khi xong, xoá Pod đi — volume và dữ liệu vẫn còn.
# =============================================================================
set -euo pipefail

VOLUME_ROOT="${VOLUME_ROOT:-/workspace}"
COMFY="${VOLUME_ROOT}/ComfyUI"

# fl2va = text / first-last-frame → video+audio  (dùng cho T2V, I2V)
# ref2va = reference (≤9 ảnh, 3 video, 3 audio) → video+audio  (dùng cho R2V)
VARIANT="${VARIANT:-fl2va}"

# Chỉ có 3 định dạng cho diffusion model (KHÔNG có nvfp4 — nvfp4 chỉ áp dụng
# cho text encoder):
#   pruned_int8_convrot  21 GB — Comfy-Org khuyến nghị, CẦN PyTorch cu130
#   pruned_fp8_scaled    21 GB — fallback khi PyTorch < cu130
#   pruned_bf16          40 GB — không lượng tử hoá, cần nhiều VRAM
#   (bản không "pruned": 34-66 GB, chỉ dùng nếu bạn có lý do cụ thể)
#
# Để trống → script tự chọn theo phiên bản CUDA của PyTorch đang cài.
QUANT="${QUANT:-auto}"

if [[ "$QUANT" == "auto" ]]; then
  if python3 -c 'import sys,torch; v=tuple(map(int,(torch.version.cuda or "0.0").split("."))); sys.exit(0 if v>=(13,0) else 1)' 2>/dev/null; then
    QUANT=pruned_int8_convrot
  else
    QUANT=pruned_fp8_scaled
  fi
  echo "==> QUANT=auto → chọn ${QUANT} (theo CUDA của PyTorch)"
fi

DIFF_FILE="minimax_h3_${VARIANT}_${QUANT}.safetensors"

echo "==> Biến thể : ${VARIANT}"
echo "==> Diffusion: ${DIFF_FILE}"
echo "==> Đích     : ${COMFY}/models"

command -v hf >/dev/null 2>&1 || pip install -U "huggingface_hub[cli]"

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "!! Chưa set HF_TOKEN. Repo có gating thì sẽ tải lỗi." >&2
  echo "   export HF_TOKEN=hf_xxx  rồi chạy lại." >&2
fi

mkdir -p "${COMFY}/models" "${COMFY}/custom_nodes"

# LƯU Ý VỀ --local-dir: hf download giữ nguyên đường dẫn trong repo.
# Repo có cấu trúc diffusion_models/... text_encoders/... vae/...
# nên --local-dir phải là ${COMFY}/models, KHÔNG phải ${COMFY}/models/vae —
# nếu không file sẽ nằm ở models/vae/vae/... và ComfyUI không nhận đúng tên.

echo "==> [1/3] Diffusion model (${DIFF_FILE})"
hf download Comfy-Org/MiniMax-H3 \
  --include "diffusion_models/${DIFF_FILE}" \
  --local-dir "${COMFY}/models"

echo "==> [2/3] Text encoder Qwen3-VL-32B (nvfp4_awq — không đòi GPU Blackwell)"
hf download Comfy-Org/MiniMax-H3 \
  --include "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" \
  --local-dir "${COMFY}/models"

echo "==> [3/3] VAE video (fp16) + audio (fp32) — cần CẢ HAI"
hf download Comfy-Org/MiniMax-H3 \
  --include "vae/minimax_h3_video_vae_fp16.safetensors" \
            "vae/minimax_h3_audio_vae_fp32.safetensors" \
  --local-dir "${COMFY}/models"

# hf download để lại blob trong cache — nếu cache nằm trên volume thì bạn
# đang trả tiền lưu trữ gấp đôi.
rm -rf "${COMFY}/models/.cache" 2>/dev/null || true
rm -rf "${HF_HOME:-$HOME/.cache/huggingface}/hub" 2>/dev/null || true

echo
echo "==> Kiểm tra — phải thấy đúng 4 file, KHÔNG lồng thêm thư mục:"
find "${COMFY}/models" -name "*.safetensors" -exec ls -lh {} \; | awk '{print $5, $NF}'

echo
echo "Tiếp theo:"
echo "  1. Mở ComfyUI, nạp template MiniMax-H3 (Templates → Video)."
echo "  2. Node loader sẽ báo đỏ nếu template trỏ tới quant khác — mở dropdown chọn file bạn có."
echo "  3. Workflow → Export (API) → workflows/h3_${VARIANT}_api.json"
echo "  4. python scripts/inspect_workflow.py workflows/h3_${VARIANT}_api.json"
