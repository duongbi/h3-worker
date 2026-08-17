#!/usr/bin/env python3
"""
Smoke test cấu hình R2 — chạy TRƯỚC khi deploy worker.

Sai credential R2 chỉ lộ ra ở cuối job (sau 5 phút GPU đã cháy). Test 10 giây
ở đây rẻ hơn nhiều.

Dùng:  set -a; source .env; set +a; python scripts/test_r2.py
"""
import os
import sys
import time
from pathlib import Path

import boto3
from botocore.config import Config

REQUIRED = ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]


def main() -> int:
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"✗ Thiếu biến môi trường: {', '.join(missing)}")
        return 1

    bucket = os.environ["R2_BUCKET"]
    public_base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")

    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 2}),
    )

    key = f"_smoketest/{int(time.time())}.txt"
    payload = b"h3-worker r2 smoke test\n"

    try:
        s3.put_object(Bucket=bucket, Key=key, Body=payload, ContentType="text/plain")
        print(f"✓ PUT   {bucket}/{key}")

        got = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        assert got == payload
        print("✓ GET   nội dung khớp")

        url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=300
        )
        print(f"✓ SIGN  {url[:100]}…")

        if public_base:
            print(f"ℹ  Public URL sẽ có dạng: {public_base}/{key}")
            print("   → Mở thử trên trình duyệt. Nếu 401/403, bucket chưa bật")
            print("     public access hoặc custom domain chưa trỏ đúng.")
        else:
            print("ℹ  Chưa set R2_PUBLIC_BASE_URL → worker sẽ trả presigned URL")
            print(f"   có hạn {os.environ.get('R2_PRESIGN_EXPIRY_SEC', '604800')}s.")

        s3.delete_object(Bucket=bucket, Key=key)
        print("✓ DELETE dọn sạch")
        print("\n✓ R2 đã sẵn sàng.")
        return 0

    except Exception as e:  # noqa: BLE001
        print(f"\n✗ Lỗi: {type(e).__name__}: {e}")
        print("\nKiểm tra:")
        print("  • R2_ENDPOINT_URL đúng dạng https://<account_id>.r2.cloudflarestorage.com")
        print("    (KHÔNG kèm tên bucket ở cuối)")
        print("  • API token có quyền Object Read & Write cho đúng bucket")
        print("  • Tên bucket viết đúng, phân biệt hoa thường")
        return 1


if __name__ == "__main__":
    sys.exit(main())
