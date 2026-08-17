#!/usr/bin/env python3
"""
Đọc file workflow ComfyUI dạng API và in ra bản đồ node → field có thể patch.

Vì sao cần: node ID trong file export là số tuỳ ý do ComfyUI sinh ra, và
thay đổi mỗi lần bạn sửa workflow. Backend patch sai node ID sẽ fail âm thầm
(ComfyUI vẫn chạy, nhưng dùng prompt cũ hardcode trong workflow).

Dùng:
    python scripts/inspect_workflow.py workflows/h3_fl2va_api.json
    python scripts/inspect_workflow.py workflows/h3_fl2va_api.json --json > node_map.json
"""
import argparse
import json
import sys

# Các field backend thường cần thay động
INTERESTING = {
    "text", "prompt", "negative_prompt", "string",
    "seed", "noise_seed",
    "steps", "cfg", "denoise", "sampler_name", "scheduler",
    "width", "height", "length", "num_frames", "frame_rate", "fps",
    "image", "images", "video", "audio", "url", "filename", "file",
    "batch_size", "duration", "shift",
    "filename_prefix", "save_output", "format", "crf", "unet_name",
}

# Node hay là điểm neo của workflow video
ANCHOR_HINTS = ("CLIPTextEncode", "LoadImage", "LoadAudio", "VHS_", "SaveImage",
                "SaveAudio", "VideoCombine", "KSampler", "EmptyLatent", "Sampler")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow")
    ap.add_argument("--json", action="store_true", help="in ra JSON thay vì bảng")
    ap.add_argument("--all", action="store_true", help="hiện mọi field, không lọc")
    args = ap.parse_args()

    with open(args.workflow, encoding="utf-8") as f:
        wf = json.load(f)

    if "nodes" in wf and isinstance(wf.get("nodes"), list):
        print("LỖI: đây là workflow dạng UI, không phải API.\n"
              "     Trong ComfyUI dùng Workflow → Export (API).", file=sys.stderr)
        return 1

    mapping = {}
    for node_id, node in sorted(wf.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0):
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "?")
        title = (node.get("_meta") or {}).get("title", "")
        fields = {}
        for k, v in (node.get("inputs") or {}).items():
            # [node_id, slot] = nối từ node khác, không phải giá trị literal
            if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int):
                continue
            if args.all or k in INTERESTING:
                fields[k] = v
        if fields:
            mapping[node_id] = {"class_type": class_type, "title": title, "fields": fields}

    if args.json:
        print(json.dumps(mapping, ensure_ascii=False, indent=2))
        return 0

    print(f"{len(wf)} node, {len(mapping)} node có field patch được\n")
    for node_id, info in mapping.items():
        star = "★" if any(h in info["class_type"] for h in ANCHOR_HINTS) else " "
        head = f"{star} [{node_id}] {info['class_type']}"
        if info["title"]:
            head += f"  «{info['title']}»"
        print(head)
        for k, v in info["fields"].items():
            s = json.dumps(v, ensure_ascii=False)
            print(f"      .{k:<16} = {s[:90]}{'…' if len(s) > 90 else ''}")
        print()

    print("Gợi ý: đặt title cho node trong ComfyUI (chuột phải → Title) thành")
    print("       PROMPT / SEED / FRAMES / FIRST_FRAME … rồi tra theo title thay vì")
    print("       theo node ID — bền hơn khi bạn sửa workflow.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
