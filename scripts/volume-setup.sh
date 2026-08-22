#!/usr/bin/env bash
# =============================================================================
#  Nạp weights MiniMax-H3 vào một RunPod Network Volume TRỐNG.
#
#  CHẠY Ở ĐÂU: trên một Pod tạm, cùng datacenter với volume mới, volume mount
#  tại /workspace (mặc định của Pod). Xong thì xoá Pod — volume vẫn còn.
#
#      VOLUME_ROOT=/workspace PROFILE=bench bash volume-setup.sh
#
#  Thay cho scripts/download_models.sh (bản cũ chưa có LoRA turbo và còn ghi
#  nhầm là "không có nvfp4 cho diffusion" — Comfy-Org không có, cộng đồng có).
# =============================================================================
set -euo pipefail

VOLUME_ROOT="${VOLUME_ROOT:-/workspace}"
MODELS="${VOLUME_ROOT}/ComfyUI/models"

# core  ~43GB — đủ chạy production hôm nay (fp8_scaled + turbo 8 bước)
# bench ~57GB — thêm NVFP4 12.5GB và LoRA 4 bước, để đo hết bảng
# all   ~78GB — thêm int8_convrot 21GB
PROFILE="${PROFILE:-bench}"

log()  { echo -e "\n\033[1m==> $*\033[0m"; }
warn() { echo "⚠  $*" >&2; }
die()  { echo "✗  $*" >&2; exit 1; }

# ---- Kiểm tra chỗ đứng ----------------------------------------------------
[ -d "$VOLUME_ROOT" ] || die "Không thấy $VOLUME_ROOT. Pod này đã gắn network volume chưa?"

case "$PROFILE" in
    core)  NEED_GB=50 ;;
    bench) NEED_GB=70 ;;
    all)   NEED_GB=95 ;;
    *)     die "PROFILE phải là core | bench | all (đang là '$PROFILE')" ;;
esac

FREE_GB="$(df -BG --output=avail "$VOLUME_ROOT" | tail -1 | tr -dc '0-9')"
log "Volume $VOLUME_ROOT còn ${FREE_GB}GB trống · PROFILE=$PROFILE cần ~${NEED_GB}GB"
if [ "${FREE_GB:-0}" -lt "$NEED_GB" ]; then
    die "Không đủ chỗ. Tạo volume to hơn, hoặc dùng PROFILE=core."
fi

# ---- Công cụ ---------------------------------------------------------------
command -v hf >/dev/null 2>&1 || pip install -q -U "huggingface_hub[cli]"
# hf_transfer kéo song song nhiều luồng — 43GB xuống còn ~10 phút thay vì ~40.
pip install -q -U hf_transfer 2>/dev/null && export HF_HUB_ENABLE_HF_TRANSFER=1 || \
    warn "không cài được hf_transfer — tải sẽ chậm hơn nhưng vẫn chạy"

[ -n "${HF_TOKEN:-}" ] || warn "HF_TOKEN trống. Repo nào có gating sẽ tải lỗi 401."

mkdir -p "$MODELS/diffusion_models" "$MODELS/text_encoders" "$MODELS/vae" "$MODELS/loras"

# ---- Tải --------------------------------------------------------------------
# ⚠ `hf download` GIỮ NGUYÊN đường dẫn bên trong repo:
#   - Comfy-Org/MiniMax-H3 để file trong diffusion_models/ text_encoders/ vae/
#     → --local-dir phải là $MODELS (thư mục cha), KHÔNG phải $MODELS/vae,
#       nếu không sẽ thành models/vae/vae/... và ComfyUI không khớp tên.
#   - lightx2v và lilcheaty để file ở GỐC repo
#     → --local-dir trỏ thẳng vào thư mục đích.
# Sai chỗ này là bẫy đã dính ngày 17/08. `verify` cuối script bắt được nó.
grab() {  # grab <repo> <local-dir> <file...>
    local repo="$1" dest="$2"; shift 2
    local args=()
    for f in "$@"; do args+=(--include "$f"); done
    hf download "$repo" "${args[@]}" --local-dir "$dest"
    # Dọn cache NGAY sau mỗi lần tải, không đợi tới cuối: cache giữ thêm một
    # bản của file vừa tải, và với file 21GB thì đó là 21GB đỉnh điểm vô ích.
    rm -rf "$dest/.cache" "${HF_HOME:-$HOME/.cache/huggingface}/hub" 2>/dev/null || true
}

log "[1] Diffusion fp8_scaled (21GB) — đường chạy ổn định hiện tại"
grab Comfy-Org/MiniMax-H3 "$MODELS" \
     "diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors"

log "[2] Text encoder Qwen3-VL-32B nvfp4_awq (14.6GB)"
grab Comfy-Org/MiniMax-H3 "$MODELS" \
     "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"

log "[3] VAE video fp16 (4.9GB) + audio fp32 (0.6GB) — cần CẢ HAI"
grab Comfy-Org/MiniMax-H3 "$MODELS" \
     "vae/minimax_h3_video_vae_fp16.safetensors" \
     "vae/minimax_h3_audio_vae_fp32.safetensors"

log "[4] Turbo LoRA 8 bước (2.0GB) — đòn bẩy tốc độ lớn nhất"
grab lightx2v/Minimax-h3-Turbo "$MODELS/loras" \
     "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"

if [ "$PROFILE" != "core" ]; then
    log "[5] Turbo LoRA 4 bước 768p v1.1 (2.0GB) — bản mới hơn v1.0"
    grab lightx2v/Minimax-h3-Turbo "$MODELS/loras" \
         "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors"

    # NVFP4 chỉ có tensor core trên Blackwell (sm_120 của 5090 là đủ).
    # 12.5GB + TE 14.6GB + VAE 5.4GB = 32.5GB → vừa 32GB VRAM, HẾT thrashing.
    # Đây là cách bên ai-muninn đạt 175s/clip trên đúng một 5090.
    # ⚠ Repo tự ghi "4-bit lộ mất chất so với int8_convrot" → phải xem video mới chốt.
    log "[6] Diffusion NVFP4 (12.5GB) — quant cộng đồng, để đo"
    grab lilcheaty/MiniMax-H3-NVFP4 "$MODELS/diffusion_models" \
         "minimax_h3_fl2va_pruned_nvfp4.safetensors"
fi

if [ "$PROFILE" = "all" ]; then
    log "[7] Diffusion int8_convrot (21GB) — Comfy-Org khuyến nghị, cần cu130"
    grab Comfy-Org/MiniMax-H3 "$MODELS" \
         "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
fi

# ---- Xác minh ---------------------------------------------------------------
log "Kiểm tra"

fails=0
verify() {  # verify <đường dẫn tương đối từ $MODELS> <MB tối thiểu>
    local rel="$1" min_mb="$2" path="$MODELS/$1"
    if [ ! -f "$path" ]; then
        echo "  ✗ THIẾU  $rel"; fails=$((fails+1)); return
    fi
    # `stat -c %s` = kích thước THẬT. Đừng dùng `du`: nó đo số block đã cấp phát
    # nên file thưa hoặc đang tải dở báo về 0 và ta tưởng là hỏng nặng.
    local mb; mb=$(( $(stat -c %s "$path") / 1024 / 1024 ))
    if [ "$mb" -lt "$min_mb" ]; then
        echo "  ✗ CỤT    $rel — ${mb}MB, đáng lẽ ≥${min_mb}MB (tải dở?)"; fails=$((fails+1))
    else
        printf "  ✓ %6sMB  %s\n" "$mb" "$rel"
    fi
}

# Ngưỡng đặt thấp hơn kích thước thật ~10% để không báo sai vì đơn vị GB/GiB.
verify "diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors" 19000
verify "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"      13000
verify "vae/minimax_h3_video_vae_fp16.safetensors"                        4000
verify "vae/minimax_h3_audio_vae_fp32.safetensors"                         450
verify "loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"  1700
if [ "$PROFILE" != "core" ]; then
    verify "loras/minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors" 1700
    verify "diffusion_models/minimax_h3_fl2va_pruned_nvfp4.safetensors"          11000
fi
[ "$PROFILE" = "all" ] && \
    verify "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"   19000

# Thư mục lồng là triệu chứng của --local-dir sai. ComfyUI sẽ không thấy file,
# và lỗi chỉ lộ ra lúc chạy job với "value not in list".
log "Thư mục lồng sai (phải KHÔNG có dòng nào)"
find "$MODELS" -mindepth 3 -name '*.safetensors' -printf '  ✗ %p\n' | tee /tmp/nested.txt
[ -s /tmp/nested.txt ] && fails=$((fails+1)) || echo "  ✓ không có"

# ⚠ TUYỆT ĐỐI KHÔNG tạo thư mục custom_nodes ở đây và cũng đừng thêm key đó
#   vào extra_model_paths.yaml — xem cảnh báo trong src/extra_model_paths.yaml.
#   Nhưng thư mục PHẢI tồn tại nếu yaml có khai. Yaml hiện tại không khai → bỏ qua.

log "Dung lượng đã dùng"
du -sh "$VOLUME_ROOT"/ComfyUI 2>/dev/null || true
df -h "$VOLUME_ROOT" | tail -1

echo
if [ "$fails" -gt 0 ]; then
    die "$fails mục hỏng. Chạy lại script — hf download bỏ qua file đã đủ, chỉ tải lại phần thiếu."
fi
cat <<'EOF'
✓ Volume sẵn sàng.

Tiếp theo:
  1. Xoá Pod tạm này (volume giữ nguyên dữ liệu).
  2. Deploy Pod thật: vào Storage → bấm volume này → Deploy, để DC tự khoá đúng.
     Volume Mount Path = /runpod-volume · Expose HTTP 8000 ·
     Start command = bash /pod-start.sh · bỏ tích Jupyter.
  3. node --env-file=.env scripts/test-pod.mjs
  4. CHƯA xoá volume cũ. Chỉ xoá sau khi Pod mới chạy ra video thật,
     và sau khi đã gỡ volume cũ khỏi endpoint Serverless.
EOF
