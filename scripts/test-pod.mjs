/**
 * Kiểm tra một Pod H3 TRƯỚC khi gửi job thật.
 *
 *   node --env-file=.env scripts/test-pod.mjs
 *
 * Không tốn giây GPU nào. Chạy cái này ngay sau khi dựng Pod, và mỗi lần Pod
 * restart. Mọi lỗi hay gặp đều lộ ra ở đây trong 5 giây, thay vì sau 6 phút
 * sampling: volume chưa gắn, thiếu biến R2, sai `POD_API_KEY`, quên tải LoRA.
 *
 * Cần trong .env:
 *   RUNPOD_BASE_URL=https://<podId>-8000.proxy.runpod.net
 *   RUNPOD_API_KEY=<POD_API_KEY đã đặt trên Pod>
 *
 * Tuỳ chọn:
 *   EXPECT_LORA=minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
 *   EXPECT_UNET=minimax_h3_fl2va_pruned_fp8_scaled.safetensors
 *     → báo LỖI nếu file đó chưa có trên volume. Dùng trước khi chạy bench.
 *
 * Mã thoát: 0 = Pod sẵn sàng nhận job · 1 = có thứ phải sửa.
 */
import { BASE, HEADERS, IS_POD, TARGET, requireConfig, fetchRetry } from "./endpoint.mjs";

requireConfig();

if (!IS_POD) {
  console.error("✗ Script này chỉ dành cho Pod, nhưng RUNPOD_BASE_URL đang trống.");
  console.error("  Đặt: RUNPOD_BASE_URL=https://<podId>-8000.proxy.runpod.net");
  console.error("  (Kiểm tra Serverless thì dùng scripts/test-endpoint.mjs.)");
  process.exit(1);
}

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); failed += 1; };
const warn = (m) => console.log(`  ⚠ ${m}`);

console.log(`Kiểm tra ${TARGET}\n`);

// ---- 1. Pod có sống không -------------------------------------------------
// /ping không cần auth, nên nó tách bạch được hai thứ rất hay bị lẫn:
// "Pod chết" với "Pod sống nhưng mình sai key".
console.log("1. Pod có phản hồi không");
try {
  const r = await fetchRetry(`${BASE}/ping`, {}, { tries: 4, label: "ping" });
  if (r.ok) ok("/ping trả 200 — pod_server đang chạy");
  else bad(`/ping trả HTTP ${r.status} — Pod chưa khởi động xong, hoặc sai cổng expose (phải là 8000)`);
} catch (e) {
  bad(`không nối được tới ${BASE} (${e.cause?.code ?? e.message})`);
  console.log("\n  Kiểm tra: Pod đang RUNNING? Đã Expose HTTP Port 8000? URL đúng dạng");
  console.log("  https://<podId>-8000.proxy.runpod.net (KHÔNG có dấu / ở cuối)?");
  process.exit(1);
}

// ---- 2. Auth có được bật không --------------------------------------------
// Cổng proxy của Pod công khai trên Internet. POD_API_KEY trống nghĩa là ai
// biết URL cũng gửi job được — và bạn trả tiền GPU cho họ.
console.log("\n2. Xác thực");
try {
  const r = await fetchRetry(`${BASE}/health`, {}, { tries: 2, label: "health không key" });
  if (r.status === 401) ok("gọi không kèm key bị chặn (401)");
  else warn(`gọi KHÔNG kèm key vẫn trả HTTP ${r.status} → POD_API_KEY đang TRỐNG trên Pod. `
    + "Ai biết URL cũng gửi job được. Đặt POD_API_KEY rồi restart Pod.");
} catch (e) {
  warn(`không kiểm tra được auth: ${e.message}`);
}

const r = await fetchRetry(`${BASE}/health`, { headers: HEADERS }, { label: "health" });
if (r.status === 401) {
  bad("RUNPOD_API_KEY trong .env KHÔNG khớp POD_API_KEY trên Pod");
  process.exit(1);
}
if (!r.ok) {
  bad(`/health trả HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}
ok("key khớp");

const h = await r.json();

// ---- 3. ComfyUI + GPU -----------------------------------------------------
console.log("\n3. ComfyUI và GPU");
if (h.comfy?.ok) {
  ok("ComfyUI sẵn sàng");
  // Đây là dòng quan trọng nhất của cả script: không có tên card thì mọi số đo
  // sau này đều không quy được nguyên nhân (bài học 18–19/08: hai lần đo cùng
  // cấu hình lệch 40%, không biết vì sao).
  console.log(`     ${h.comfy.report}`);
  if (/driver=không đọc được/.test(h.comfy.report ?? "")) {
    warn("không đọc được driver — nvidia-smi thiếu trong container?");
  }
} else {
  bad(`ComfyUI CHƯA sẵn sàng: ${JSON.stringify(h.comfy ?? {})}`);
  console.log("     Xem log Pod: ComfyUI thường chết vì volume chưa mount đúng chỗ.");
}

const w = h.workers ?? {}, j = h.jobs ?? {};
console.log(`     worker: ${w.idle ?? "?"} rảnh / ${w.running ?? "?"} chạy`);
if ((j.inQueue ?? 0) > 0) warn(`${j.inQueue} job đang xếp hàng — Pod đang bận`);
if ((j.failed ?? 0) > 0) warn(`${j.failed} job đã hỏng kể từ lần khởi động gần nhất`);

// ---- 4. Weights trên volume ----------------------------------------------
console.log("\n4. Weights ComfyUI nhìn thấy trên volume");
async function listModels(kind) {
  const res = await fetchRetry(`${BASE}/models/${kind}`, { headers: HEADERS }, { label: kind });
  if (!res.ok) {
    bad(`/models/${kind} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return [];
  }
  const body = await res.json();
  return Array.isArray(body.items) ? body.items : [];
}

const unets = await listModels("diffusion_models");
if (unets.length) ok(`diffusion_models (${unets.length}): ${unets.join(", ")}`);
else bad("KHÔNG có diffusion model nào — volume chưa gắn, hoặc sai Volume Mount Path");

const loras = await listModels("loras");
if (loras.length) ok(`loras (${loras.length}): ${loras.join(", ")}`);
else warn("chưa có LoRA nào trên volume — chưa chạy được cấu hình turbo của bench.mjs");

for (const [envName, list, label] of [
  ["EXPECT_UNET", unets, "diffusion model"],
  ["EXPECT_LORA", loras, "LoRA"],
]) {
  const want = process.env[envName];
  if (!want) continue;
  if (list.includes(want)) ok(`${label} '${want}' đã có`);
  else bad(`${label} '${want}' KHÔNG có trên volume — tải lên trước khi bench`);
}

// ---- Kết luận -------------------------------------------------------------
console.log();
if (failed) {
  console.log(`✗ ${failed} vấn đề phải sửa trước khi gửi job.`);
  process.exit(1);
}
console.log("✓ Pod sẵn sàng. Gửi một job thật:");
console.log('  node --env-file=.env scripts/test-endpoint.mjs "prompt của bạn"');
console.log("Rồi trỏ backend vào Pod bằng cách đặt trong SERVER/.env:");
console.log(`  RUNPOD_BASE_URL=${BASE}`);
