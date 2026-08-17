# Build & Deploy — runbook

Đường đi: **GitHub Actions → ghcr.io → RunPod Template → Serverless Endpoint**.

Bạn không cần Docker trên máy. Toàn bộ build chạy trên CI.

Thứ tự dưới đây có phụ thuộc lẫn nhau — đừng nhảy cóc. Giai đoạn 1 là giai đoạn duy nhất tốn tiền GPU, và nó phải xong trước khi tạo endpoint.

---

## Giai đoạn 0 — Đưa code lên GitHub

```bash
cd h3-worker
git init && git add . && git commit -m "h3-worker: initial"
gh repo create h3-worker --private --source=. --push
# hoặc tạo repo trên web rồi:
#   git remote add origin https://github.com/<user>/h3-worker.git
#   git branch -M main && git push -u origin main
```

Push đầu tiên sẽ kích hoạt workflow và **fail ở bước deploy** — đúng như dự kiến, vì chưa có template. Bước build vẫn chạy và đẩy image lên ghcr.io.

> Tên image trên ghcr **phải viết thường**. Nếu username GitHub của bạn có chữ hoa, workflow đã tự `tr` về chữ thường rồi.

---

## Giai đoạn 1 — Network volume + weights + workflow

Đây là phần tốn thời gian nhất và phải làm thủ công một lần.

### 1.1 Tạo network volume

Console RunPod → **Storage → Network Volume**.

- **Datacenter**: chọn DC **có sẵn RTX 5090 hoặc L40S**. Volume gắn chặt với một DC, và endpoint dùng volume đó chỉ chạy được worker trong DC ấy. Chọn sai ở đây là phải làm lại từ đầu.
- **Size**: 250 GB cho một biến thể lượng tử hoá (~$17.5/tháng).

### 1.2 Thuê Pod tạm và tải weights

Console → **Pods → Deploy** → cùng DC → attach volume vừa tạo (mount `/workspace`) → template ComfyUI. GPU rẻ nhất cũng được, bước này chỉ tải file.

```bash
# Trong web terminal của Pod
git clone https://github.com/<user>/h3-worker.git && cd h3-worker
export HF_TOKEN=hf_xxx
export VARIANT=fl2va QUANT=int8_convrot
bash scripts/download_models.sh
```

### 1.3 Dựng workflow và export

Mở ComfyUI qua HTTP proxy của Pod → nạp template MiniMax-H3 → chỉnh tới khi ra clip ưng ý **ở đúng độ phân giải sản phẩm (768p)**.

Đặt title cho các node cần patch động (xem `workflows/README.md`), rồi `Workflow → Export (API)`.

```bash
python scripts/inspect_workflow.py workflows/h3_fl2va_api.json
```

Commit file workflow vào repo (nhớ bỏ dòng `workflows/*.json` trong `.gitignore` nếu muốn commit).

### 1.4 Ghi lại và xoá Pod

Ghi lại: thời gian/clip ở 768p, peak VRAM, số steps, danh sách custom node đã cài. Nếu có custom node ngoài `comfyui-videohelpersuite`, thêm vào `Dockerfile`.

**Xoá Pod** — volume và dữ liệu vẫn còn. Đừng để Pod chạy không.

---

## Giai đoạn 2 — Mở public cho package trên ghcr

Package trên ghcr mặc định là **private**. RunPod pull private image sẽ fail với lỗi `unauthorized` mà không nói rõ nguyên nhân.

`github.com/users/<user>/packages/container/h3-worker/settings` → **Change visibility → Public**.

Image này không chứa weights lẫn secret (R2 credential nằm ở env của endpoint, không nằm trong image) nên để public là an toàn.

> Muốn giữ private: tạo Container Registry Auth trong RunPod console và gán `containerRegistryAuthId` cho template. Phức tạp hơn, không cần thiết ở giai đoạn này.

---

## Giai đoạn 3 — Kiểm tra image đã lên

Tab **Actions** của repo → job build phải xanh. Kiểm tra:

```bash
docker manifest inspect ghcr.io/<user>/h3-worker:latest   # nếu có docker
# hoặc mở: github.com/<user>?tab=packages
```

---

## Giai đoạn 4 — Tạo Template + Endpoint

```bash
export RUNPOD_API_KEY=rpa_xxx
set -a; source .env; set +a        # nạp R2_*

# Xem tài nguyên đang có (lấy volume id)
python scripts/runpod_setup.py --list

# Xem trước, chưa tạo gì
python scripts/runpod_setup.py --dry-run \
  --image ghcr.io/<user>/h3-worker:latest \
  --volume-id <volume_id> \
  --gpu 'NVIDIA GeForce RTX 5090' --gpu 'NVIDIA L40S'

# Tạo thật
python scripts/runpod_setup.py \
  --image ghcr.io/<user>/h3-worker:latest \
  --volume-id <volume_id> \
  --gpu 'NVIDIA GeForce RTX 5090' --gpu 'NVIDIA L40S' \
  --workers-max 3 --idle-timeout 90 --execution-timeout 900
```

Tên GPU phải khớp chính xác với tên RunPod dùng — copy từ màn hình tạo endpoint trong console. Khai báo nhiều loại để tăng khả năng bắt được máy trống.

Script in ra `templateId` và `endpointId` ở cuối.

**Tại sao image nằm ở Template chứ không ở Endpoint:** trên RunPod, Endpoint chỉ trỏ tới `templateId`. Muốn đổi image là PATCH template — đó là điều `runpod_deploy.sh` làm.

---

## Giai đoạn 5 — Bật CD

GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Giá trị |
|---|---|
| `RUNPOD_API_KEY` | API key RunPod |
| `RUNPOD_TEMPLATE_ID` | `templateId` từ giai đoạn 4 |

Từ giờ mỗi lần push lên `main` (có đụng vào `Dockerfile` hoặc `src/`), CI sẽ build, push image tag theo commit SHA, rồi PATCH template. RunPod tự rolling release.

Workflow cố ý deploy bằng **tag SHA** chứ không phải `:latest` — để RunPod thấy image thực sự đổi, và để bạn biết chính xác worker đang chạy commit nào.

---

## Giai đoạn 6 — Gọi thử

```bash
export RUNPOD_ENDPOINT_ID=<endpoint_id>
curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" \
  https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/health | jq .

bash scripts/curl_examples.sh runpod
```

**Request đầu tiên sẽ rất chậm** — pull image + nạp ~32 GB weights từ network volume. Vài phút là bình thường. Đừng vội kết luận là hỏng.

---

## Khi có gì đó sai

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Worker `unauthorized` / không pull được image | Package trên ghcr còn private (giai đoạn 2), hoặc tên image có chữ hoa |
| Worker khởi động rồi chết ngay | Thiếu env R2, hoặc network volume chưa attach → `extra_model_paths.yaml` trỏ vào `/runpod-volume` rỗng |
| ComfyUI báo thiếu node | Custom node có trong workflow nhưng chưa thêm vào `Dockerfile` |
| Job chạy mãi rồi `TIMED_OUT` | `executionTimeout` thấp hơn thời gian thật ở 768p. `COMFY_MAX_WAIT_SEC` phải **nhỏ hơn** `executionTimeout` để handler kịp trả lỗi đẹp |
| `no output files` | Node lưu đang ở chế độ preview, hoặc `save_output: false` |
| Actions fail: `no space left on device` | Base image nặng. Workflow đã có bước dọn đĩa; nếu vẫn thiếu, xoá thêm `/opt/hostedtoolcache` |
| Endpoint không bao giờ scale lên | GPU đã khai báo không có sẵn trong DC của volume. Thêm loại GPU khác vào `gpuTypeIds` |

Đọc log worker ở console: **Serverless → endpoint → Workers → chọn worker → Logs**. Handler in log với tiền tố `[h3-worker]`.

---

## Chi phí cần canh

- `workersMax` là **trần chi tiêu** của bạn. Đặt ở mức bạn chấp nhận trả nếu nó chạy hết công suất cả ngày.
- Network volume tính tiền kể cả khi không có worker nào chạy.
- Pod tạm ở giai đoạn 1: **nhớ xoá**. Đây là khoản lãng phí phổ biến nhất.
- Bật alert chi tiêu theo ngày trong RunPod console ngay từ hôm nay, đừng đợi hoá đơn đầu tiên.
