#!/usr/bin/env python3
"""
Kiểm tra mọi class_type mà workflow cần đều tồn tại trong source ComfyUI.

    python scripts/check_workflow_nodes.py <workflow.json> [thư-mục-ComfyUI]

Mặc định thư mục ComfyUI là /comfyui (đường dẫn trong image).

Vì sao tồn tại: ngày 18/08/2026, image build xanh và deploy xong mới lộ ra lỗi
"Node 'MiniMax H3 Image to Video' not found" — vì bước cập nhật ComfyUI trong
Dockerfile im lặng không có tác dụng (checkout nhánh local cũ thay vì origin/master).
Mất ~1 tiếng cho một thứ kiểm tra được trong 1 giây. Chạy bước này NGAY TRONG BUILD
để hỏng thì hỏng sớm.

Cách kiểm tra là quét text: tìm tên class dưới dạng chuỗi trong NODE_CLASS_MAPPINGS
hoặc dưới dạng `class <Tên>`. Không import ComfyUI vì import cần cả torch lẫn GPU.
Đây là kiểm tra thô — có thể lọt lưới (false negative) nếu node được đăng ký động,
nhưng không bao giờ báo thiếu nhầm thứ đang có (false positive).
"""
import json
import pathlib
import re
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    wf_path = pathlib.Path(sys.argv[1])
    root = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "/comfyui")

    if not root.is_dir():
        print(f"!! Không thấy thư mục ComfyUI: {root}", file=sys.stderr)
        return 2

    wf = json.loads(wf_path.read_text(encoding="utf-8"))
    needed = sorted({
        n["class_type"] for n in wf.values()
        if isinstance(n, dict) and "class_type" in n
    })
    if not needed:
        print(f"!! Không đọc được class_type nào từ {wf_path} — file có đúng định dạng API không?",
              file=sys.stderr)
        return 2

    chunks = []
    for p in root.rglob("*.py"):
        if ".git" in p.parts:
            continue
        try:
            chunks.append(p.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            pass
    blob = "\n".join(chunks)

    missing = [
        n for n in needed
        if not re.search(rf"[\"']{re.escape(n)}[\"']|class\s+{re.escape(n)}\b", blob)
    ]

    print(f"Workflow {wf_path.name} cần {len(needed)} loại node:")
    for n in needed:
        print(f"  {'✗' if n in missing else '✓'} {n}")

    if missing:
        print(f"\n!! THIẾU {len(missing)} node trong {root}: {', '.join(missing)}", file=sys.stderr)
        print("!! Nâng COMFYUI_VERSION lên bản có các node này, hoặc cài custom node tương ứng.",
              file=sys.stderr)
        return 1

    print("\n✓ Tất cả node workflow cần đều có mặt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
