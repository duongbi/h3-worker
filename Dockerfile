# =============================================================================
#  MiniMax-H3 video worker cho RunPod Serverless
#  Base: runpod/worker-comfyui — đã có sẵn ComfyUI + comfy-cli + runpod SDK
#  Ta chỉ override /handler.py bằng bản hiểu VIDEO và upload thẳng lên R2.
# =============================================================================
# QUAN TRỌNG — chọn đúng biến thể CUDA theo GPU:
#   *-base-cuda12.8.1  → BẮT BUỘC cho RTX 5090 (Blackwell, sm_120).
#                        CUDA 12.6 KHÔNG hỗ trợ sm_120, worker sẽ crash lúc
#                        nạp model với lỗi "no kernel image is available".
#   *-base             → CUDA 12.6, đủ cho L40S / A6000 / A100 / H100 (≤ Ada).
#
# Tag mới nhất: https://hub.docker.com/r/runpod/worker-comfyui/tags
ARG WORKER_COMFYUI_TAG=5.8.5-base-cuda12.8.1
FROM runpod/worker-comfyui:${WORKER_COMFYUI_TAG}

# ---- Dependencies bổ sung -----------------------------------------------
# boto3: upload lên Cloudflare R2 (S3-compatible)
# httpx : tải asset đầu vào từ presigned URL, có retry
RUN pip install --no-cache-dir boto3==1.35.* httpx==0.27.*

# ---- Cập nhật ComfyUI ----------------------------------------------------
# BẮT BUỘC: base image được build từ trước, ComfyUI trong đó có thể CŨ HƠN bản
# bạn dùng để dựng workflow trên Pod. Các node MiniMaxH3ImageToVideo,
# ResolutionSelector, ComfyMathExpression, SaveVideo, CreateVideo là node core
# nhưng chỉ có ở ComfyUI mới — thiếu là workflow fail với "node type not found".
#
# Đặt COMFYUI_VERSION = đúng tag/commit bạn đã test trên Pod (chạy
# `cd /workspace/ComfyUI && git describe --tags` để lấy). Để "master" thì build
# lấy bản mới nhất — tiện nhưng không tái lập được.
# Nhận được: tag (v0.3.x), nhánh (master), hoặc SHA đầy đủ 40 ký tự.
# SHA RÚT GỌN sẽ KHÔNG hoạt động với `git fetch` — phải dùng bản đầy đủ
# (`git rev-parse HEAD` trên Pod).
#
# ⚠ BẪY ĐÃ DÍNH (18/08/2026): trước đây chỗ này là `git checkout "${COMFYUI_VERSION}"`.
#   Base image ĐÃ CÓ SẴN nhánh local `master` trỏ vào commit cũ, nên `git checkout master`
#   chỉ chuyển sang nhánh local đó chứ KHÔNG lấy `origin/master` vừa fetch về.
#   Build vẫn xanh, image vẫn giữ ComfyUI tháng 3/2026, và job chết ở runtime với
#   "Node 'MiniMax H3 Image to Video' not found". Luôn ưu tiên `origin/<nhánh>`.
ARG COMFYUI_VERSION=master
RUN cd /comfyui \
 && git config --global --add safe.directory /comfyui \
 && if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then \
        git fetch --unshallow origin || git fetch origin; \
    fi \
 && git fetch origin --tags --force --prune \
 && TARGET="$( git rev-parse --verify --quiet "origin/${COMFYUI_VERSION}^{commit}" \
            || git rev-parse --verify --quiet "refs/tags/${COMFYUI_VERSION}^{commit}" \
            || git rev-parse --verify --quiet "${COMFYUI_VERSION}^{commit}" \
            || { git fetch --depth 1 origin "${COMFYUI_VERSION}" >/dev/null 2>&1 \
                 && git rev-parse FETCH_HEAD; } )" \
 && if [ -z "$TARGET" ]; then \
        echo "!! Không phân giải được COMFYUI_VERSION='${COMFYUI_VERSION}'"; exit 1; \
    fi \
 && git checkout --detach --force "$TARGET" \
 && git log -1 --format='ComfyUI @ %H (%ci)' \
 && git describe --tags \
 && grep -viE '^(torch|torchvision|torchaudio)([=<>~!].*)?$' requirements.txt > /tmp/req.txt \
 && pip install --no-cache-dir -r /tmp/req.txt \
 && rm /tmp/req.txt

# ---- PyTorch cu130 -------------------------------------------------------
# VÌ SAO: base image đi kèm torch 2.10.0+cu128, và với cu128 thì comfy_kitchen
# TẮT backend `cuda` lẫn `triton`, chỉ còn `eager`. Log worker in rất rõ:
#     WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations
#     Found comfy_kitchen backend cuda:   {'available': True, 'disabled': True, ...}
#     Found comfy_kitchen backend triton: {'available': True, 'disabled': True, ...}
# Text encoder của H3 là nvfp4 (qwen3vl_32b_..._nvfp4_awq) nên mỗi lần forward
# phải gọi `dequantize_nvfp4` hàng trăm lần bằng đường eager chậm nhất.
# Đo được 18/08/2026: video 4s / 10 steps mất 227s execute — quá chậm.
# Nâng cu130 bật lại kernel tối ưu, và mở đường dùng diffusion bản
# `pruned_int8_convrot` sau này (bản đó cũng đòi cu130).
#
# ⚠ RÀNG BUỘC DRIVER — đọc trước khi build:
#   CUDA 13.0 cần driver Linux >= 580.65.06. Host RunPod còn r570/r575 thì torch
#   sẽ chết ngay khi chạm GPU với "CUDA driver version is insufficient for CUDA
#   runtime version". handler.py in driver + bản torch ra đầu mỗi job
#   (xem `_gpu_report`) nên nhìn log là biết ngay, không phải đoán.
#   Quay lui: build lại với `--build-arg TORCH_CHANNEL=cu128`, hoặc nhanh hơn là
#   trỏ Template về image tag SHA cũ (mọi tag SHA vẫn còn trên ghcr).
#
# Đặt SAU bước cài requirements của ComfyUI để pip không kéo ngược torch về cu128.
# 3 gói phải khớp bộ: torch 2.10.0 ↔ torchvision 0.25.0 ↔ torchaudio 2.10.0.
# torchaudio là bắt buộc, không bỏ được: H3 sinh cả audio, ComfyUI nạp
# comfy_extras/nodes_audio.py lúc khởi động.
ARG TORCH_CHANNEL=cu130
ARG TORCH_VERSION=2.10.0
ARG TORCHVISION_VERSION=0.25.0
ARG TORCHAUDIO_VERSION=2.10.0
RUN set -eux; \
    if [ "${TORCH_CHANNEL}" = "cu128" ]; then \
        echo ">> TORCH_CHANNEL=cu128 → giữ nguyên torch của base image"; \
    else \
        pip install --no-cache-dir --upgrade \
            --index-url "https://download.pytorch.org/whl/${TORCH_CHANNEL}" \
            "torch==${TORCH_VERSION}" \
            "torchvision==${TORCHVISION_VERSION}" \
            "torchaudio==${TORCHAUDIO_VERSION}"; \
        python -c "import torch,sys; v=torch.version.cuda or ''; print('>> torch', torch.__version__, '| cuda', v); sys.exit(0 if v.split('.')[0]=='13' else 1)"; \
    fi

# ---- Custom nodes --------------------------------------------------------
# Workflow h3_fl2va_api.json hiện CHỈ dùng node core → không cần custom node nào.
# Nếu sau này bạn thêm node vào workflow, khai báo ở đây:
#   RUN comfy-node-install <tên-package>

# ---- Kiểm tra node bắt buộc NGAY LÚC BUILD -------------------------------
# Vì sao: lỗi "node type not found" trước đây chỉ lộ ra sau khi build 35 phút,
# deploy, cold start rồi gửi job — mất cả tiếng cho một thứ kiểm tra được trong 1 giây.
# Thiếu node là build FAIL, không bao giờ ra tới RunPod nữa.
COPY scripts/check_workflow_nodes.py /tmp/check_workflow_nodes.py
COPY workflows/h3_fl2va_api.json /tmp/wf.json
RUN python /tmp/check_workflow_nodes.py /tmp/wf.json /comfyui \
 && rm -f /tmp/check_workflow_nodes.py /tmp/wf.json

# ---- Trỏ ComfyUI sang network volume ------------------------------------
# Weights KHÔNG nằm trong image (31.7 GB — image sẽ pull rất chậm).
# Chúng nằm trên network volume, mount vào /runpod-volume lúc chạy.
COPY src/extra_model_paths.yaml /comfyui/extra_model_paths.yaml

# ---- Handler tuỳ biến ----------------------------------------------------
# Ghi đè /handler.py của upstream. start.sh vẫn giữ nguyên:
#   python -u /comfyui/main.py ... &
#   python -u /handler.py
COPY src/handler.py /handler.py

# ---- Chế độ POD ----------------------------------------------------------
# CÙNG MỘT IMAGE chạy được cả Serverless lẫn Pod — chỉ khác lệnh khởi động.
# Cố ý không tách image riêng cho Pod: hai image sẽ lệch nhau sau vài tuần, và
# lúc đó mọi so sánh tốc độ giữa hai môi trường đều vô nghĩa.
#
#   Serverless : CMD mặc định bên dưới → /start.sh → ComfyUI + /handler.py
#   Pod        : Container Start Command = `bash /pod-start.sh`
#                → ComfyUI + /pod_server.py (giả lập API RunPod trên cổng 8000)
#
# ⚠ Cả hai file PHẢI được git theo dõi, nếu không build sẽ chết ở CI với
#   "failed to compute cache key: not found" trong khi máy local vẫn có file.
#   Kiểm tra: git check-ignore -q <file> && echo BI_IGNORE
COPY src/pod_server.py    /pod_server.py
COPY scripts/pod-start.sh /pod-start.sh
RUN chmod +x /pod-start.sh

# ---- Cấu hình mặc định ---------------------------------------------------
ENV COMFY_HOST=127.0.0.1:8188 \
    COMFY_POLL_INTERVAL_MS=1000 \
    COMFY_MAX_WAIT_SEC=1800 \
    OUTPUT_DIR=/comfyui/output \
    INPUT_DIR=/comfyui/input \
    R2_PUBLIC_BASE_URL="" \
    R2_PRESIGN_EXPIRY_SEC=604800 \
    POD_PORT=8000 \
    POD_CONCURRENCY=1

# Mặc định vẫn là Serverless. Pod override bằng Container Start Command.
CMD ["/start.sh"]
