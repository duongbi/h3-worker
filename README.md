# h3-worker — MiniMax-H3 trên RunPod Serverless

Worker sinh video bằng MiniMax-H3, chạy ComfyUI, upload kết quả lên Cloudflare R2 và trả URL cho backend.

Xây trên `runpod/worker-comfyui` — chỉ override `/handler.py` để hiểu output **video** thay vì ảnh.

> **Muốn build & deploy ngay? Đọc [DEPLOY.md](DEPLOY.md)** — runbook đầy đủ từ `git init` tới endpoint chạy được.

```
h3-worker/
├── Dockerfile                    # base worker-comfyui + custom nodes + handler
├── DEPLOY.md                     # ★ runbook build & deploy
├── .env.example
├── test_input.json
├── .github/workflows/
│   └── build-and-deploy.yml      # CI: build → ghcr.io → PATCH template RunPod
├── src/
│   ├── handler.py                # ★ phần code chính
│   └── extra_model_paths.yaml    # trỏ ComfyUI sang /runpod-volume
├── workflows/
│   └── README.md                 # cách export workflow API + bản đồ node
└── scripts/
    ├── download_models.sh        # tải weights vào network volume
    ├── inspect_workflow.py       # in bản đồ node ID để backend patch
    ├── test_handler_mock.py      # test handler KHÔNG cần GPU (~2 giây)
    ├── test_r2.py                # smoke test R2 (chạy TRƯỚC khi tốn tiền GPU)
    ├── test_local.sh             # chạy worker local với API giả lập
    ├── curl_examples.sh          # ví dụ /run, /status, /cancel
    ├── runpod_setup.py           # tạo Template + Endpoint qua REST API (chạy 1 lần)
    └── runpod_deploy.sh          # PATCH image của template (CI gọi mỗi lần push)
```

## Test nhanh, không cần GPU

```bash
pip install runpod httpx
python scripts/test_handler_mock.py
```

Dựng một ComfyUI giả lập + R2 giả lập, chạy hết 6 tình huống trong ~2 giây. Chạy cái này mỗi lần sửa `handler.py`, trước khi build image.

---

## Thứ tự làm — đừng đảo

Mỗi bước sau đều phụ thuộc bước trước. Nhảy cóc sẽ mất thời gian debug ở chỗ đắt tiền nhất (GPU đang chạy).

### 1. Network Volume trước tiên

Volume gắn chặt với **một datacenter**. Serverless endpoint dùng volume đó chỉ chạy được worker trong DC ấy — nên hãy chọn DC có sẵn GPU bạn định dùng (5090 / L40S).

- 250 GB đủ cho 1 biến thể lượng tử hoá (~$17.5/tháng ở mức standard).
- Cân nhắc bản **high-performance** ($0.14/GB/mo): nạp model nhanh hơn, cắt trực tiếp vào cold start. Chênh lệch chỉ ~$17/tháng.

### 2. Tải weights bằng Pod tạm

Thuê Pod on-demand **cùng DC**, mount volume vào `/workspace`:

```bash
export HF_TOKEN=hf_xxx
export VARIANT=fl2va          # hoặc ref2va
export QUANT=int8_convrot     # hoặc fp8_scaled / nvfp4
bash scripts/download_models.sh
```

Chọn quant thế nào:

| Quant | Khi nào dùng |
|---|---|
| `int8_convrot` | Comfy-Org khuyến nghị **nếu** PyTorch chạy được CUDA 13.0 |
| `fp8_scaled` | Fallback an toàn khi không dùng được `int8_convrot` |
| `nvfp4` | Nhỏ và nhanh nhất trên RTX 5090 (Blackwell). Text encoder bản `nvfp4_awq` **không** đòi Blackwell nên dùng được cả trên L40S/A6000 |

Có cả bản `pruned` nhẹ hơn — đáng thử để giảm cold start, nhưng benchmark chất lượng trước.

### 3. Dựng workflow trong ComfyUI, rồi export

Vẫn trên Pod đó, mở ComfyUI, nạp template MiniMax-H3, chỉnh tới khi ưng.

**Đo ở đúng độ phân giải sản phẩm** (768p), không phải 480p — số 480p sẽ làm bạn tính sai giá bán.

```bash
# Workflow → Export (API) → lưu vào workflows/h3_fl2va_api.json
python scripts/inspect_workflow.py workflows/h3_fl2va_api.json
```

Xem `workflows/README.md` để biết node nào cần đặt title.

Xoá Pod sau khi xong — volume vẫn còn.

### 4. Test R2 trước khi build

```bash
cp .env.example .env && $EDITOR .env
set -a; source .env; set +a
python scripts/test_r2.py
```

Mười giây ở đây thay cho 5 phút GPU cháy rồi mới biết credential sai.

### 5. Build & push image

```bash
docker build -t <user>/h3-worker:0.1.0 .
docker push <user>/h3-worker:0.1.0
```

Image nhẹ (~vài GB) vì **weights không nằm trong image** — chúng ở network volume.

### 6. Tạo Serverless Endpoint

| Cấu hình | Giá trị | Vì sao |
|---|---|---|
| Container image | `<user>/h3-worker:0.1.0` | |
| GPU | 5090 32GB, **thêm** L40S 48GB làm fallback | Chọn nhiều loại để tăng khả năng bắt được máy trống |
| Network volume | volume ở bước 1 | Mount tự động tại `/runpod-volume` |
| Active workers | `0` ngoài giờ, `1` giờ cao điểm | 1 active = trả tiền 24/7 nhưng xoá cold start cho request đầu |
| Max workers | `3` để mở màn | **Đây là trần chi phí của bạn** |
| Idle timeout | `60–120s` | Giữ worker ấm giữa các request trong một đợt bùng nổ |
| Execution timeout | `900s` | Mặc định 600s có thể không đủ cho 768p |
| FlashBoot | bật | Giảm cold start cho worker vừa scale xuống |
| Env vars | toàn bộ khối R2 trong `.env` | |

### 7. Gọi thử

```bash
export RUNPOD_API_KEY=... RUNPOD_ENDPOINT_ID=...
bash scripts/curl_examples.sh runpod
```

---

## Hợp đồng API

**Request**

```json
{
  "input": {
    "workflow": { "3": { "class_type": "KSampler", "inputs": { "seed": 42 } } },
    "assets": [
      { "name": "first_frame.png", "url": "https://r2.example.com/tmp/abc.png" },
      { "name": "voice.wav", "base64": "data:audio/wav;base64,UklGR..." }
    ],
    "meta": { "jobId": "uuid-của-bạn" },
    "output_prefix": "videos/2026/08"
  },
  "webhook": "https://api.your-app.com/webhooks/runpod?token=...",
  "policy": { "executionTimeout": 900000, "ttl": 3600000 }
}
```

**Response**

```json
{
  "videos": [{
    "url": "https://cdn.your-app.com/videos/2026/08/<jobid>/H3_00001.mp4",
    "key": "videos/2026/08/<jobid>/H3_00001.mp4",
    "filename": "H3_00001.mp4",
    "sizeBytes": 8431221,
    "contentType": "video/mp4"
  }],
  "images": [], "audios": [],
  "meta": { "jobId": "uuid-của-bạn" },
  "timings": { "queueMs": 120, "executeMs": 402113, "uploadMs": 2841, "totalMs": 405074 },
  "warnings": []
}
```

`meta` được echo nguyên vẹn — dùng nó để map ngược về job trong DB của bạn ở webhook handler.

---

## Những chỗ dễ sai

**Handler báo "không sinh ra file output nào"**
Node lưu đang ở chế độ preview (`PreviewImage`) hoặc `VHS_VideoCombine` có `save_output: false`. Handler cố tình bỏ qua file `type: "temp"`.

**ComfyUI từ chối workflow (400)**
Handler trả nguyên văn `node_errors` của ComfyUI. Thường là thiếu custom node — thêm vào `Dockerfile` bằng `comfy-node-install`, hoặc cài vào `custom_nodes/` trên network volume.

**Cold start quá lâu**
Nạp ~32 GB từ network volume là phần đau nhất. Bốn cách, dùng kết hợp: idle timeout dài · 1 active worker theo lịch cao điểm · volume high-performance · dùng bản `pruned`. Song song đó, ở tầng UX hãy báo ETA trung thực ngay khi nhận job — cold start chỉ đau nếu bạn hứa nhanh hơn thực tế.

**Worker chết sau vài chục job**
Đầy disk. Handler đã `unlink` file sau khi upload, nhưng nếu bạn sửa code thì đừng bỏ bước đó — worker sống lâu qua nhiều job.

**Payload quá lớn**
`/run` giới hạn 10MB, `/runsync` 20MB. Đừng nhồi ảnh base64 cho Ref2VA (tới 12 file) — dùng presigned URL qua `assets[].url`.

**Mất webhook**
RunPod chỉ retry 2 lần, cách nhau 10s. Backend cần một reconciler cron 60s quét job quá hạn và gọi `/status`. Kết quả của `/run` **chỉ được giữ 30 phút** — reconciler chạy thưa hơn thế là mất kết quả vĩnh viễn.

---

## Kiểm soát chi phí

- `maxWorkers` là trần chi tiêu. Đặt ở mức bạn chấp nhận trả nếu nó chạy hết công suất cả ngày.
- Đặt `ttl` để job nằm trong hàng đợi quá lâu tự huỷ — đừng trả tiền cho job người dùng đã bỏ đi.
- Hàng đợi nội bộ (BullMQ/Redis) trước RunPod: giới hạn số job đồng thời gửi lên. Không có nó, một user spam 500 request sẽ đẩy RunPod scale lên trần.
- Trừ credit **khi submit**, hoàn lại khi `FAILED`.

---

## License

MiniMax-H3 phát hành theo **MiniMax H3 Community License Agreement** — có ràng buộc về nội dung và thường có ngưỡng doanh thu cho sử dụng thương mại. Đọc toàn văn LICENSE trên repo gốc trước khi thương mại hoá; đừng dựa vào bản tóm tắt nào, kể cả file này.
