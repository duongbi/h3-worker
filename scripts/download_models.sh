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
MODELS="${VOLUME_ROOT}/ComfyUI/models"

# Chọn biến thể lượng tử hoá:
#   int8_convrot  — Comfy-Org khuyến nghị NẾU chạy được PyTorch cu130
#   fp8_scaled    — fallback khi không dùng được int8_convrot
#   nvfp4         — nhỏ và nhanh nhất, tối ưu cho Blackwell (RTX 5090)
QUANT="${QUANT:-int8_convrot}"

# fl2va = text/first-last-frame → video+audio
# ref2va = reference (tối đa 9 ảnh, 3 video, 3 audio) → video+audio
VARIANT="${VARIANT:-fl2va}"

echo "==> Biến thể: ${VARIANT} | Lượng tử hoá: ${QUANT}"
echo "==> Đích: ${MODELS}"

command -v hf >/dev/null 2>&1 || pip install -U "huggingface_hub[cli]"

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "!! Chưa set HF_TOKEN. Repo có gating thì sẽ tải lỗi." >&2
  echo "   export HF_TOKEN=hf_xxx  rồi chạy lại." >&2
fi

mkdir -p "${MODELS}"/{diffusion_models,text_encoders,vae,loras,upscale_models}
mkdir -p "${VOLUME_ROOT}/ComfyUI/custom_nodes"

# --- Transformer ------------------------------------------------------------
echo "==> [1/3] Transformer (${VARIANT}, ${QUANT})"
hf download Comfy-Org/MiniMax-H3 \
  --include "*${VARIANT}*${QUANT}*" \
  --local-dir "${MODELS}/diffusion_models"

# --- Text encoder (Qwen3-VL-32B) --------------------------------------------
# Bản nvfp4_awq KHÔNG đòi GPU Blackwell — dùng được cả trên L40S/A6000.
echo "==> [2/3] Text encoder Qwen3-VL-32B (nvfp4_awq)"
hf download Comfy-Org/MiniMax-H3 \
  --include "*qwen3vl*nvfp4_awq*" \
  --local-dir "${MODELS}/text_encoders"

# --- VAE (video + audio) ----------------------------------------------------
echo "==> [3/3] VAE video (fp16) + audio (fp32)"
hf download Comfy-Org/MiniMax-H3 \
  --include "*vae*" \
  --local-dir "${MODELS}/vae"

# --- Dọn cache --------------------------------------------------------------
# hf download để lại blob trong ~/.cache/huggingface — nếu cache nằm trên
# volume thì bạn đang trả tiền lưu trữ gấp đôi.
rm -rf "${HF_HOME:-$HOME/.cache/huggingface}/hub" 2>/dev/null || true

echo
echo "==> Xong. Dung lượng đã dùng:"
du -sh "${MODELS}"/* 2>/dev/null || true
echo
echo "Kiểm tra nhanh — các file này phải tồn tại:"
find "${MODELS}" -name "*.safetensors" -o -name "*.sft" | head -20
echo
echo "Tiếp theo:"
echo "  1. Mở ComfyUI trên Pod này, nạp template MiniMax-H3, chạy thử vài clip."
echo "  2. Workflow → Export (API) → lưu vào workflows/h3_${VARIANT}_api.json"
echo "  3. Ghi lại node ID của: prompt text, seed, num_frames, ảnh đầu/cuối."
