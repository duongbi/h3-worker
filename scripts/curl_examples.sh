#!/usr/bin/env bash
# =============================================================================
#  Ví dụ gọi worker — local hoặc RunPod
#  Dùng: bash scripts/curl_examples.sh local
#        bash scripts/curl_examples.sh runpod
# =============================================================================
set -euo pipefail
MODE="${1:-local}"

if [[ "$MODE" == "local" ]]; then
  BASE="http://localhost:8000"
  AUTH=()
else
  : "${RUNPOD_ENDPOINT_ID:?Chưa set RUNPOD_ENDPOINT_ID}"
  : "${RUNPOD_API_KEY:?Chưa set RUNPOD_API_KEY}"
  BASE="https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}"
  AUTH=(-H "Authorization: Bearer ${RUNPOD_API_KEY}")
fi

echo "### 1. Health check — xem worker đang ở trạng thái nào"
curl -s "${AUTH[@]}" "${BASE}/health" | jq . || true
echo

echo "### 2. Submit job async (LUỒNG CHÍNH — dùng cái này)"
cat > /tmp/h3_payload.json <<'JSON'
{
  "input": {
    "workflow": {},
    "assets": [],
    "meta": { "jobId": "demo-001" },
    "output_prefix": "videos/2026/08"
  },
  "webhook": "https://api.your-app.com/webhooks/runpod?token=CHANGE_ME",
  "policy": { "executionTimeout": 900000, "ttl": 3600000 }
}
JSON
# Nhét workflow thật vào payload
jq --slurpfile wf workflows/h3_fl2va_api.json \
   '.input.workflow = $wf[0]' /tmp/h3_payload.json > /tmp/h3_payload_full.json

JOB=$(curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
        -d @/tmp/h3_payload_full.json "${BASE}/run")
echo "$JOB" | jq .
JOB_ID=$(echo "$JOB" | jq -r .id)
echo

echo "### 3. Poll trạng thái (fallback khi webhook chết)"
echo "    Lưu ý: kết quả của /run chỉ được giữ 30 PHÚT sau khi xong."
while true; do
  R=$(curl -s "${AUTH[@]}" "${BASE}/status/${JOB_ID}")
  S=$(echo "$R" | jq -r .status)
  echo "    status=$S  $(echo "$R" | jq -c '.output.state? // empty')"
  case "$S" in
    COMPLETED) echo "$R" | jq '.output.videos'; break ;;
    FAILED|CANCELLED|TIMED_OUT) echo "$R" | jq .; break ;;
  esac
  sleep 10
done
echo

cat <<'EOF'
### 4. Các lệnh khác hay dùng

# Huỷ job đang chạy (dừng đốt tiền GPU ngay)
curl -X POST -H "Authorization: Bearer $RUNPOD_API_KEY" \
  "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/cancel/$JOB_ID"

# Xoá sạch hàng đợi (khi lỡ submit nhầm hàng loạt)
curl -X POST -H "Authorization: Bearer $RUNPOD_API_KEY" \
  "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/purge-queue"

# ĐỪNG dùng /runsync cho luồng chính: job 3–7 phút sẽ treo kết nối HTTP,
# và kết quả chỉ được giữ 1 phút.
EOF
