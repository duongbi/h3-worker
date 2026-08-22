#!/usr/bin/env bash
# =============================================================================
#  In ra ĐÚNG khối Environment Variables để dán vào RunPod → Pod → Edit.
#
#      bash scripts/pod-env.sh
#
#  Vì sao có script này thay vì copy tay: 5 biến R2 gõ sai một ký tự thì job vẫn
#  sampling xong 5 phút rồi mới chết lúc upload. Đọc thẳng từ .env đang chạy được
#  là hết cửa sai.
#
#  ⚠ Script này IN RA SECRET. Đừng chạy khi đang share màn hình, và đừng dán
#    output vào chat/issue/commit.
# =============================================================================
set -euo pipefail

ENV_FILE="${1:-$(dirname "$0")/../.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo "✗ Không thấy $ENV_FILE" >&2
    echo "  Dùng: bash scripts/pod-env.sh [đường/dẫn/tới/.env]" >&2
    exit 1
fi

# Đọc bằng grep + cut, KHÔNG `source`.
# `source` file .env này sẽ chết: các dòng comment kiểu
#   # Dạng: https://<account_id>.r2...
# bị bash hiểu là redirect `<` và `>`, lệnh gãy giữa chừng, các biến sau đó rỗng
# — im lặng, không báo gì. Đã dính đúng lỗi này 19/08/2026.
get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

missing=()
for v in R2_BUCKET R2_ENDPOINT_URL R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    [ -n "$(get "$v")" ] || missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
    echo "✗ $ENV_FILE thiếu: ${missing[*]}" >&2
    exit 1
fi

# Key mới mỗi lần chạy. Cổng proxy của Pod công khai trên Internet — không có
# key thì ai biết URL cũng gửi job được và bạn trả tiền GPU cho họ.
POD_KEY="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p -c 48)"

cat <<EOF

===============================================================================
 DÁN VÀO: RunPod → Pod → Edit → Environment Variables
 (mỗi dòng là một cặp Key / Value)
===============================================================================
R2_BUCKET=$(get R2_BUCKET)
R2_ENDPOINT_URL=$(get R2_ENDPOINT_URL)
R2_ACCESS_KEY_ID=$(get R2_ACCESS_KEY_ID)
R2_SECRET_ACCESS_KEY=$(get R2_SECRET_ACCESS_KEY)
R2_PUBLIC_BASE_URL=$(get R2_PUBLIC_BASE_URL)
POD_API_KEY=$POD_KEY
COMFY_LOG_LEVEL=INFO

===============================================================================
 THÊM VÀO: h3-worker/.env   (để scripts/*.mjs nói chuyện với Pod)
===============================================================================
RUNPOD_BASE_URL=https://<podId>-8000.proxy.runpod.net
RUNPOD_API_KEY=$POD_KEY

===============================================================================
 THÊM VÀO: SERVER/.env      (để backend gọi Pod thay vì Serverless)
===============================================================================
RUNPOD_BASE_URL=https://<podId>-8000.proxy.runpod.net
RUNPOD_API_KEY=$POD_KEY

-------------------------------------------------------------------------------
 <podId> lấy ở RunPod → Pod → nút Connect (chuỗi ~14 ký tự trước dấu -8000).
 KHÔNG để dấu / ở cuối URL.

 ⚠ RUNPOD_API_KEY ở hai file .env giờ là POD_API_KEY, KHÔNG phải API key của
   tài khoản RunPod. Đây là chủ ý: Pod xác thực bằng key riêng của nó.
   API key tài khoản vẫn cần nếu bạn quay lại Serverless — giữ lại một bản.
-------------------------------------------------------------------------------
EOF
