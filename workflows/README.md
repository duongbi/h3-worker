# Workflow templates

Thư mục này chứa các file workflow ComfyUI **dạng API** mà backend sẽ patch rồi gửi lên worker.

## Vì sao repo không kèm sẵn file workflow chạy được

Node ID trong file export là số do ComfyUI tự sinh, phụ thuộc vào chính workflow bạn dựng và phiên bản custom node bạn cài. Một file copy từ nơi khác gần như chắc chắn sẽ lệch. Bạn phải tự export từ Pod của mình.

## Quy trình

1. Trên Pod tạm, mở ComfyUI → nạp template MiniMax-H3 (RunPod và Comfy-Org đều có template day-0).
2. Chỉnh tới khi ra clip ưng ý ở **đúng độ phân giải và độ dài của sản phẩm**.
3. Đặt title cho các node bạn sẽ patch động (chuột phải → *Title*):

   | Title đề xuất | Node | Field |
   |---|---|---|
   | `PROMPT` | CLIPTextEncode | `text` |
   | `NEGATIVE` | CLIPTextEncode | `text` |
   | `SEED` | KSampler / Sampler | `seed` hoặc `noise_seed` |
   | `FRAMES` | node tạo latent video | `length` / `num_frames` |
   | `FIRST_FRAME` | LoadImage | `image` |
   | `LAST_FRAME` | LoadImage | `image` |
   | `SAVE_VIDEO` | VHS_VideoCombine | `filename_prefix` |

4. `Workflow → Export (API)` → lưu thành `h3_fl2va_api.json` trong thư mục này.
5. Chạy `python scripts/inspect_workflow.py workflows/h3_fl2va_api.json` để lấy bản đồ node ID.
6. Đưa bản đồ đó vào backend (hàm `buildWorkflow`).

## Lưu ý về node lưu file

Handler quét **mọi** output của mọi node và lấy file thật trên đĩa. Nhưng nó chỉ thấy được file nếu node lưu ghi ra `type: "output"`, không phải `"temp"`.

- ✅ `VHS_VideoCombine` với `save_output: true`
- ✅ `SaveImage`, `SaveAudio`
- ❌ `PreviewImage` — chỉ ghi vào temp, handler sẽ bỏ qua

Nếu workflow chạy xong mà handler báo *"không sinh ra file output nào"*, gần như chắc chắn là node lưu đang ở chế độ preview hoặc bị mute.

## Ảnh đầu vào

Backend gửi asset qua `input.assets`, handler tải về `/comfyui/input/<name>`. Trong workflow, node `LoadImage` chỉ cần trỏ `image` tới đúng tên file đó — không cần đường dẫn tuyệt đối.

```json
{
  "input": {
    "workflow": { "...": "..." },
    "assets": [
      { "name": "first_frame.png", "url": "https://r2.example.com/tmp/abc.png" }
    ]
  }
}
```

Và trong workflow: `wf["31"].inputs.image = "first_frame.png"`.
