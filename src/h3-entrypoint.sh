#!/usr/bin/env bash
# =============================================================================
#  CMD của image. Chọn chế độ chạy theo BIẾN MÔI TRƯỜNG, không theo lệnh khởi động.
#
#      H3_MODE=serverless  (mặc định) → /start.sh → ComfyUI + /handler.py
#      H3_MODE=pod                    → /pod-start.sh → ComfyUI + /pod_server.py
#
#  VÌ SAO KHÔNG DÙNG "Container Start Command" CỦA RUNPOD:
#  ngày 22/08/2026 đã dán lệnh vào ô đó và nó KHÔNG được áp dụng — Pod chạy
#  CMD mặc định `/start.sh`, tức handler Serverless. Trên Pod thì RunPod SDK
#  không có hàng đợi job nên rơi vào chế độ local-test, đọc /test_input.json
#  của base image, fail với "images is not a valid input option", handler thoát,
#  container restart. Lặp 10 lần trong 45 giây và không có một dòng nào nói vì sao.
#
#  Biến môi trường thì luôn ăn (5 biến R2 chưa bao giờ hụt). Nên chuyển việc
#  chọn chế độ sang thứ đáng tin hơn, và để ô kia trống.
#
#  Chế độ mặc định vẫn là serverless ⇒ endpoint 3tody6vyko2zgd không đổi hành vi.
# =============================================================================
set -euo pipefail

# Hạ chữ thường + cắt khoảng trắng: giá trị này gõ tay vào ô env trên RunPod,
# và "Pod " với " pod" không đáng làm chết cả container.
MODE="$(echo "${H3_MODE:-serverless}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
echo "[h3-entrypoint] H3_MODE=${MODE}" >&2

case "$MODE" in
    pod)
        [ -f /pod-start.sh ] || { echo "[h3-entrypoint] !! thiếu /pod-start.sh trong image" >&2; exit 1; }
        exec bash /pod-start.sh
        ;;
    serverless)
        exec /start.sh
        ;;
    *)
        echo "[h3-entrypoint] !! H3_MODE='${MODE}' không hợp lệ. Chỉ nhận: pod | serverless" >&2
        exit 1
        ;;
esac
