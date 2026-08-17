#!/usr/bin/env bash
# =============================================================================
#  Đổi image của template trên RunPod → endpoint tự rolling release
#
#  Dùng:  bash scripts/runpod_deploy.sh ghcr.io/user/h3-worker:abc1234
#
#  Cần:   RUNPOD_API_KEY, RUNPOD_TEMPLATE_ID
#
#  Vì sao PATCH template chứ không PATCH endpoint: trên RunPod, image nằm ở
#  Template, không nằm ở Endpoint. Endpoint chỉ trỏ tới templateId.
# =============================================================================
set -euo pipefail

IMAGE="${1:?Thiếu tham số image. Ví dụ: ghcr.io/user/h3-worker:abc1234}"
: "${RUNPOD_API_KEY:?Chưa set RUNPOD_API_KEY}"
: "${RUNPOD_TEMPLATE_ID:?Chưa set RUNPOD_TEMPLATE_ID}"

API="https://rest.runpod.io/v1"

echo "==> Template hiện tại"
curl -fsS -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  "${API}/templates/${RUNPOD_TEMPLATE_ID}" | jq '{id, name, imageName}'

echo "==> Đổi sang: ${IMAGE}"
RESP=$(curl -fsS -X PATCH \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg img "$IMAGE" '{imageName: $img}')" \
  "${API}/templates/${RUNPOD_TEMPLATE_ID}")

echo "$RESP" | jq '{id, name, imageName}'

NEW=$(echo "$RESP" | jq -r .imageName)
if [[ "$NEW" != "$IMAGE" ]]; then
  echo "!! RunPod trả về imageName='${NEW}', không khớp '${IMAGE}'" >&2
  exit 1
fi

cat <<EOF

✓ Đã cập nhật template.

Worker đang chạy sẽ hoàn thành job hiện tại rồi mới được thay bằng image mới.
Request đầu tiên sau khi đổi image sẽ chịu cold start đầy đủ (pull image +
nạp ~32GB weights) — đừng deploy vào giờ cao điểm.

Kiểm tra:
  curl -s -H "Authorization: Bearer \$RUNPOD_API_KEY" \\
    https://api.runpod.ai/v2/\$RUNPOD_ENDPOINT_ID/health | jq .
EOF
