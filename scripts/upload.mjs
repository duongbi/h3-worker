/**
 * Đẩy một file local lên R2 rồi in URL công khai.
 *
 *   node --env-file=.env scripts/upload.mjs ./anh-dau.jpg
 *   node --env-file=.env scripts/upload.mjs ./anh-dau.jpg inputs/test1.jpg
 *
 * Dùng để làm gì: worker chỉ nhận ảnh đầu vào qua URL — nó tải về
 * /comfyui/input trước khi chạy. Ảnh nằm trên máy bạn thì worker không thấy.
 * Script này là bước trung gian ngắn nhất giữa "ảnh trong Downloads" và
 * "IMAGE=... node scripts/test-endpoint.mjs".
 *
 * Cần trong .env: R2_BUCKET, R2_ENDPOINT_URL, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, và R2_PUBLIC_BASE_URL nếu muốn có link công khai
 * (không có thì script in presigned URL hạn 7 ngày — vẫn dùng được).
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const need = ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`✗ Thiếu biến môi trường: ${missing.join(", ")}`);
  process.exit(1);
}

const src = process.argv[2];
if (!src) {
  console.error("Cách dùng: node --env-file=.env scripts/upload.mjs <file> [key trên R2]");
  process.exit(1);
}

const TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg",
};

const bucket = process.env.R2_BUCKET;
const publicBase = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const ext = extname(src).toLowerCase();
// Giữ nguyên đuôi file trong key: LoadImage bên ComfyUI nhận diện bằng nội dung,
// nhưng đuôi đúng giúp bạn nhìn URL là biết đang gửi cái gì.
const key = process.argv[3] ?? `inputs/${Date.now()}-${basename(src)}`;

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

const body = await readFile(src);
await s3.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: body,
  ContentType: TYPES[ext] ?? "application/octet-stream",
}));

const url = publicBase
  ? `${publicBase}/${key}`
  : await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 604800 });

console.log(`✓ ${(body.length / 1024).toFixed(0)} KB → ${bucket}/${key}`);
console.log(`\nIMAGE=${url}\n`);
console.log("Dán thẳng vào lệnh test:");
console.log(`  IMAGE=${url} MEGAPIXELS=0.7 STEPS=14 EASYCACHE=0.2 \\`);
console.log(`    node --env-file=.env scripts/test-endpoint.mjs "mô tả chuyển động"`);
