# =============================================================================
#  MiniMax-H3 video worker cho RunPod Serverless
#  Base: runpod/worker-comfyui — đã có sẵn ComfyUI + comfy-cli + runpod SDK
#  Ta chỉ override /handler.py bằng bản hiểu VIDEO và upload thẳng lên R2.
# =============================================================================
# Kiểm tra tag mới nhất tại: https://hub.docker.com/r/runpod/worker-comfyui/tags
ARG WORKER_COMFYUI_VERSION=5.4.0
FROM runpod/worker-comfyui:${WORKER_COMFYUI_VERSION}-base

# ---- Dependencies bổ sung -----------------------------------------------
# boto3: upload lên Cloudflare R2 (S3-compatible)
# httpx : tải asset đầu vào từ presigned URL, có retry
RUN pip install --no-cache-dir boto3==1.35.* httpx==0.27.*

# ---- Custom nodes --------------------------------------------------------
# VideoHelperSuite: node VHS_VideoCombine để ghép frame + audio thành mp4.
# LƯU Ý: danh sách này phải khớp với workflow bạn export ra từ ComfyUI.
#        Chạy `comfy node show all` trong Pod tạm để lấy đúng tên package.
RUN comfy-node-install comfyui-videohelpersuite

# ---- Trỏ ComfyUI sang network volume ------------------------------------
# Weights KHÔNG nằm trong image (31.7 GB — image sẽ pull rất chậm).
# Chúng nằm trên network volume, mount vào /runpod-volume lúc chạy.
COPY src/extra_model_paths.yaml /comfyui/extra_model_paths.yaml

# ---- Handler tuỳ biến ----------------------------------------------------
# Ghi đè /handler.py của upstream. start.sh vẫn giữ nguyên:
#   python -u /comfyui/main.py ... &
#   python -u /handler.py
COPY src/handler.py /handler.py

# ---- Cấu hình mặc định ---------------------------------------------------
ENV COMFY_HOST=127.0.0.1:8188 \
    COMFY_POLL_INTERVAL_MS=1000 \
    COMFY_MAX_WAIT_SEC=1800 \
    OUTPUT_DIR=/comfyui/output \
    INPUT_DIR=/comfyui/input \
    R2_PUBLIC_BASE_URL="" \
    R2_PRESIGN_EXPIRY_SEC=604800

CMD ["/start.sh"]
