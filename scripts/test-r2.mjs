/**
 * Smoke test cấu hình R2 — bản Node, không cần Python.
 *
 *   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *   node --env-file=.env scripts/test-r2.mjs
 *
 * (Node >= 20.6 mới có --env-file. Node cũ hơn: tự export biến rồi chạy.)
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const need = ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`✗ Thiếu biến môi trường: ${missing.join(", ")}`);
  process.exit(1);
}

const bucket = process.env.R2_BUCKET;
const publicBase = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT_URL,
  // Bắt buộc: nếu không, SDK dùng virtual-hosted style và ghép tên bucket
  // thành subdomain (<bucket>.<host>) → ENOTFOUND.
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const key = `_smoketest/${Date.now()}.txt`;
const body = "h3-worker r2 smoke test\n";

try {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" }));
  console.log(`✓ PUT    ${bucket}/${key}`);

  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await got.Body.transformToString();
  if (text !== body) throw new Error("nội dung đọc về không khớp");
  console.log("✓ GET    nội dung khớp");

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
  console.log(`✓ SIGN   ${url.slice(0, 100)}…`);

  if (publicBase) {
    console.log(`ℹ  Public URL sẽ có dạng: ${publicBase}/${key}`);
    console.log("   → Mở thử trên trình duyệt. 401/403 nghĩa là bucket chưa bật public access.");
  } else {
    console.log("ℹ  Chưa set R2_PUBLIC_BASE_URL → worker sẽ trả presigned URL có hạn.");
  }

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log("✓ DELETE dọn sạch\n✓ R2 đã sẵn sàng.");
} catch (e) {
  console.error(`\n✗ Lỗi: ${e.name}: ${e.message}`);

  // Tên bucket sai là lỗi phổ biến nhất — liệt kê luôn cho khỏi phải đoán.
  if (e.name === "NoSuchBucket") {
    try {
      const { Buckets } = await s3.send(new ListBucketsCommand({}));
      console.error(`\nBucket đang có trong tài khoản này (${Buckets?.length ?? 0}):`);
      for (const b of Buckets ?? []) console.error(`   • ${b.Name}`);
      console.error(`\nR2_BUCKET đang đặt là: "${bucket}"`);
      if (!Buckets?.length) {
        console.error("   → Danh sách rỗng: R2_ENDPOINT_URL đang trỏ vào account khác,");
        console.error("     hoặc API token thuộc account khác với nơi bạn tạo bucket.");
      }
    } catch (le) {
      console.error(`\n(Không liệt kê được bucket: ${le.name} — token có thể thiếu quyền list)`);
    }
  }

  console.error("\nKiểm tra:");
  console.error("  • R2_ENDPOINT_URL dạng https://<account_id>.r2.cloudflarestorage.com (KHÔNG kèm tên bucket)");
  console.error("  • API token có quyền Object Read & Write đúng bucket");
  console.error("  • Tên bucket viết đúng, phân biệt hoa thường");
  process.exit(1);
}
