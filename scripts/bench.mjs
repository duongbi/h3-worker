/**
 * Quét nhiều cấu hình gen video, chạy TUẦN TỰ, in bảng so sánh.
 *
 *   node --env-file=.env scripts/bench.mjs "prompt của bạn"
 *
 * Vì sao tuần tự chứ không song song: endpoint chỉ có vài worker và mọi cấu hình
 * phải chạy trên cùng điều kiện. Chạy song song thì job sau tranh GPU với job
 * trước, số đo thành rác.
 *
 * Vì sao dùng chung SEED và PROMPT cho mọi cấu hình: để so được CẢ tốc độ lẫn
 * chất lượng. Khác seed thì hai video khác nhau, không chấm được.
 *
 * Đích (Pod hay Serverless) do scripts/endpoint.mjs quyết định theo .env.
 *
 * Biến môi trường:
 *   PRESET=mp          bộ cấu hình (mặc định `mp`):
 *                      `mp`         = quét 1.0 → 0.4 MP với turbo LoRA.
 *                                     ĐÂY LÀ BỘ NÊN CHẠY — số đo 22/08 cho thấy
 *                                     điểm ảnh mới là biến chi phối, không phải
 *                                     lượng tử hoá hay số bước.
 *                      `nvfp4`      = fp8 vs NVFP4 vs NVFP4+LoRA vs fp8+LoRA
 *                      `turbo`      = chỉ so LoRA, giữ weights fp8
 *                      `resolution` = bộ cũ quét megapixels/steps
 *   SEED=42            mặc định 42 — cố định để so ảnh
 *   DURATION=10        áp cho mọi cấu hình
 *   ASPECT=...         áp cho mọi cấu hình
 *   COMPILE=1          bật torch.compile cho mọi cấu hình
 *   LORA=...           đổi tên file LoRA 8 bước
 *   LORA_4STEP=...     đổi tên file LoRA 4 bước 768p
 *   UNET_FP8=... / UNET_NVFP4=...   đổi tên file diffusion model
 *   LORA_STRENGTH=1.0  áp cho mọi cấu hình có LoRA
 *   USD_PER_SEC=...    thêm cột $/video vào bảng. Pod 5090 = 0.000275,
 *                      Pod RTX PRO 6000 96GB = 0.00058, Serverless 5090 = 0.000439
 *   IMAGE=... IMAGE_LAST=...   chạy cả loạt ở chế độ I2V
 *   CONFIGS='[{...}]'  JSON thay hẳn bộ cấu hình. Mỗi phần tử nhận
 *                      { label, megapixels, steps, easycache, compile, lora, unet }
 *   OUT=bench.json     nơi ghi kết quả thô (mặc định bench-results.json)
 *
 * Chi phí: mỗi cấu hình là một job thật. Trên RTX 5090 ở 1MP, một job 8 bước mất
 * ~6 phút; ở 0.4MP thì ngắn hơn nhiều. Bộ `mp` 4 cấu hình ≈ 15–18 phút GPU (~$0.28).
 * Đọc kỹ bảng trước khi chạy lại.
 */
import { readFile, writeFile } from "node:fs/promises";
import { buildWorkflow } from "./build-workflow.mjs";
import { BASE, HEADERS as H, TARGET, IS_POD, requireConfig, fetchRetry, sleep, health, submitJob } from "./endpoint.mjs";

requireConfig();

// Tên file trên volume. Đổi ở đây, đừng rải vào từng cấu hình.
const LORA_8 = process.env.LORA
  ?? "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors";
const LORA_4_768P = process.env.LORA_4STEP
  ?? "minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors";
const UNET_FP8 = process.env.UNET_FP8
  ?? "minimax_h3_fl2va_pruned_fp8_scaled.safetensors";
const UNET_NVFP4 = process.env.UNET_NVFP4
  ?? "minimax_h3_fl2va_pruned_nvfp4.safetensors";

/**
 * Bộ mặc định (sửa 22/08/2026 sau lần đo THẬT trên Pod RTX 5090).
 *
 * VÌ SAO ĐỔI: lần đo 22/08 20:35 trên 5090 ra **510s / 44.5 s mỗi bước thật** —
 * trùng khít với lần 19/08 09:27 cũng trên 5090 (44.3 s/it). Tức mốc 338.8s
 * trong bảng benchmark **KHÔNG PHẢI số của 5090** (log hôm đó không in tên card).
 * Baseline thật của 5090 là ~44.5 s/bước.
 *
 * Hệ quả làm đảo thứ tự ưu tiên: ở 44.5 s/bước, Turbo LoRA 8 bước chỉ còn
 * 8×44.5 = 356s sampling, so với 9 bước thật hôm nay là 400s — **LoRA một mình
 * chỉ mua được ~44 giây**. Nút thắt không phải số bước, mà là 19983MB diffusion
 * + 14956MB text encoder nhồi vào 31GB VRAM: aimdo stream liên tục.
 * → NVFP4 (12.5GB) mới là đòn bẩy chính. Bộ này đo nó TRƯỚC.
 *
 * Mỗi dòng đổi ĐÚNG MỘT biến so với dòng trên, để quy được nguyên nhân:
 *   1 → 2: chỉ đổi weights   (đo riêng NVFP4)
 *   1 → 4: chỉ thêm LoRA     (đo riêng LoRA)
 *   2 → 3: thêm LoRA lên NVFP4 (cấu hình đích)
 *
 * LoRA và EasyCache KHÔNG đi với nhau: ở 8 bước, hai bước liền nhau không còn
 * đủ giống để tái dùng. Vì thế mọi dòng LoRA đều `easycache: 0`.
 */
const NVFP4_CONFIGS = [
  { label: "mốc  fp8·14·EC",   unet: UNET_FP8,   megapixels: 1.0, steps: 14, easycache: 0.2 },
  { label: "nvfp4·14·EC",      unet: UNET_NVFP4, megapixels: 1.0, steps: 14, easycache: 0.2 },
  { label: "nvfp4·turbo8",     unet: UNET_NVFP4, megapixels: 1.0, steps: 8,  easycache: 0, lora: LORA_8 },
  { label: "fp8·turbo8",       unet: UNET_FP8,   megapixels: 1.0, steps: 8,  easycache: 0, lora: LORA_8 },
];

/** Chỉ so LoRA, giữ nguyên weights fp8. Dùng: PRESET=turbo */
const TURBO_CONFIGS = [
  { label: "mốc fp8·14·EC",    unet: UNET_FP8, megapixels: 1.0, steps: 14, easycache: 0.2 },
  { label: "turbo 1MP·8",      unet: UNET_FP8, megapixels: 1.0, steps: 8,  easycache: 0, lora: LORA_8 },
  { label: "turbo 1MP·4·768p", unet: UNET_FP8, megapixels: 1.0, steps: 4,  easycache: 0, lora: LORA_4_768P },
];

/**
 * Quét ĐỘ PHÂN GIẢI — bộ quan trọng nhất sau lần đo 22/08/2026 21:15–21:28.
 *
 * Số liệu thật trên Pod RTX 5090, 1MP · 10s:
 *   fp8·14·EC     staged 19983MB · 8 bước thật · 465.2s · ~44.5 s/bước
 *   nvfp4·14·EC   staged 11944MB · 9 bước thật · 416.6s ·  40.9 s/bước
 *   nvfp4·turbo8  staged 11944MB · 8 bước thật · 367.4s ·  41.3 s/bước
 *
 * Hai kết luận, cả hai đều BÁC BỎ giả thuyết trước đó:
 *  1. NVFP4 nạp ĐÚNG (11944MB thay vì 19983MB) mà s/bước chỉ giảm 8%.
 *     ⇒ nút thắt KHÔNG phải thrashing VRAM. Model nghẽn ở TÍNH TOÁN.
 *  2. Turbo LoRA 8 bước cho đúng 8 lượt forward — bằng y hệt 14 bước + EasyCache
 *     (skip 6, còn 8). ⇒ LoRA và EasyCache LÀM CÙNG MỘT VIỆC, cộng vào không lợi.
 *
 * Còn đúng một biến chưa động tới: SỐ ĐIỂM ẢNH. Bên ai-muninn đạt 175s/clip trên
 * cùng RTX 5090 ở **864×480 = 0.41MP**, còn ta chạy 1MP (9:16 → ~768×1344) —
 * gấp 2.5 lần điểm ảnh. 41 s/bước ÷ 2.5 ≈ 16 s/bước, vừa khớp con số của họ.
 * Bộ này đo thẳng đường cong đó.
 *
 * Dùng: PRESET=mp
 */
const MP_CONFIGS = [
  { label: "1.0MP·turbo8", unet: UNET_FP8, megapixels: 1.0, steps: 8, easycache: 0, lora: LORA_8 },
  { label: "0.7MP·turbo8", unet: UNET_FP8, megapixels: 0.7, steps: 8, easycache: 0, lora: LORA_8 },
  { label: "0.5MP·turbo8", unet: UNET_FP8, megapixels: 0.5, steps: 8, easycache: 0, lora: LORA_8 },
  { label: "0.4MP·turbo8", unet: UNET_FP8, megapixels: 0.4, steps: 8, easycache: 0, lora: LORA_8 },
];

/** Bộ cũ — quét độ phân giải/steps của model GỐC. Dùng: PRESET=resolution */
const RESOLUTION_CONFIGS = [
  { label: "gốc 1MP·20",  megapixels: 1.0,  steps: 20, easycache: 0.2 },
  { label: "0.7MP·20",    megapixels: 0.7,  steps: 20, easycache: 0.2 },
  { label: "0.7MP·14",    megapixels: 0.7,  steps: 14, easycache: 0.2 },
  { label: "0.7MP·12",    megapixels: 0.7,  steps: 12, easycache: 0.2 },
  { label: "0.5MP·12",    megapixels: 0.5,  steps: 12, easycache: 0.2 },
];

const PRESETS = { mp: MP_CONFIGS, nvfp4: NVFP4_CONFIGS, turbo: TURBO_CONFIGS, resolution: RESOLUTION_CONFIGS };
const PRESET = process.env.PRESET ?? "mp";
if (!process.env.CONFIGS && !PRESETS[PRESET]) {
  console.error(`✗ PRESET='${PRESET}' không có. Chọn: ${Object.keys(PRESETS).join(" | ")}`);
  process.exit(1);
}

const CONFIGS = process.env.CONFIGS ? JSON.parse(process.env.CONFIGS) : PRESETS[PRESET];
const SEED = Number(process.env.SEED ?? 42);
const OUT = process.env.OUT ?? "bench-results.json";

/** Gửi một job rồi chờ xong. Trả về {ok, executeMs, totalMs, url, error}. */
async function runOne(baseWf, cfg, prompt) {
  const { wf, assets, label } = buildWorkflow(baseWf, {
    ...cfg,
    prompt,
    seed: SEED,
    duration: process.env.DURATION ?? 10,
    aspect: process.env.ASPECT,
    compile: cfg.compile ?? process.env.COMPILE === "1",
    // cfg.lora do bộ cấu hình quyết định; LORA_STRENGTH áp chung cho cả loạt
    // để mỗi lần bench chỉ đổi đúng một biến.
    loraStrength: cfg.loraStrength ?? process.env.LORA_STRENGTH,
    unet: cfg.unet ?? process.env.UNET,
    firstFrame: process.env.IMAGE,
    lastFrame: process.env.IMAGE_LAST,
  });

  console.log(`\n▶ ${cfg.label}`);
  console.log(`  ${label} · seed ${SEED}`);

  let id;
  try {
    ({ id } = await submitJob({
      input: { workflow: wf, assets, meta: { jobId: cfg.label }, output_prefix: "videos/bench" },
      policy: { executionTimeout: 1_500_000, ttl: 3_600_000 },
    }));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  console.log(`  job ${id}`);

  const t0 = Date.now();
  for (;;) {
    await sleep(10_000);
    let j;
    try {
      const res = await fetchRetry(`${BASE}/status/${id}`, { headers: H }, { tries: 6, label: "poll" });
      if (!res.ok) continue;
      j = await res.json();
    } catch {
      console.log("    ⚠ mất mạng kéo dài — vẫn tiếp tục chờ");
      continue;
    }

    if (j.status === "COMPLETED") {
      const t = j.output?.timings ?? {};
      const v = j.output?.videos?.[0];
      console.log(`  ✓ ${(t.executeMs / 1000).toFixed(0)}s  ${v?.url ?? "(không có video)"}`);
      return { ok: true, jobId: id, ...t, url: v?.url, sizeBytes: v?.sizeBytes };
    }
    if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(j.status)) {
      console.log(`  ✗ ${j.status}`);
      return { ok: false, jobId: id, error: `${j.status}: ${JSON.stringify(j.error ?? j.output ?? {}).slice(0, 300)}` };
    }
    // Nhịp báo mỗi phút cho đỡ sốt ruột, không spam mỗi 10s như test-endpoint.
    const mins = (Date.now() - t0) / 60_000;
    if (Math.floor(mins) > Math.floor((Date.now() - t0 - 10_000) / 60_000)) {
      console.log(`    ${mins.toFixed(0)}m  ${j.status}`);
    }
  }
}

// ---- Chạy -----------------------------------------------------------------
const prompt = process.argv[2] ??
  "A calm seaside at golden hour, gentle waves, a lone sailboat drifting. " +
  "Audio: soft waves, distant seagulls, warm ambient pad.";

const baseWf = JSON.parse(await readFile(new URL("../workflows/h3_fl2va_api.json", import.meta.url), "utf8"));

console.log(`Quét ${CONFIGS.length} cấu hình · ${TARGET}`);
console.log(`prompt: ${prompt.slice(0, 70)}…`);
console.log(`seed cố định: ${SEED}\n`);

// Hỏi /health TRƯỚC khi tốn tiền GPU. Trên Pod, dòng `GPU=<tên> <VRAM>GB` in ra
// ở đây là thứ duy nhất cho phép về sau quy số đo về đúng card. Thiếu nó thì cả
// loạt bench thành vô dụng — đúng bài học 18–19/08.
try {
  const h = await health();
  if (IS_POD && !h.body?.comfy?.ok) {
    console.error("\n✗ ComfyUI trên Pod chưa sẵn sàng. Dừng để khỏi đốt tiền GPU vô ích.");
    process.exit(1);
  }
} catch (e) {
  console.error(`✗ không hỏi được /health: ${e.message}`);
  process.exit(1);
}

console.log("\nChạy tuần tự. Cứ để đó, kết quả in dần.");

const results = [];
for (const cfg of CONFIGS) {
  let r;
  try {
    r = await runOne(baseWf, cfg, prompt);
  } catch (e) {
    r = { ok: false, error: e.message };
    console.log(`  ✗ ${e.message}`);
  }
  results.push({ ...cfg, ...r });
  await writeFile(OUT, JSON.stringify({ prompt, seed: SEED, results }, null, 2));
}

// ---- Bảng tổng kết --------------------------------------------------------
const okRuns = results.filter((r) => r.ok);
const baseline = okRuns[0];

// $/giây của card đang chạy — đặt để bảng có luôn cột $/video, con số thật sự
// quyết định. Pod 5090 = 0.99/3600 = 0.000275 · Pod RTX PRO 6000 = 0.00058 ·
// Serverless 5090 = 0.000439. Xem runpod.io/pricing.
const USD_PER_SEC = Number(process.env.USD_PER_SEC ?? 0);

console.log("\n\n=== KẾT QUẢ ===\n");
const money = USD_PER_SEC > 0;
console.log(`| cấu hình | execute | s/bước | so với mốc |${money ? " $/video |" : ""} video |`);
console.log(`|---|---|---|---|${money ? "---|" : ""}---|`);
for (const r of results) {
  if (!r.ok) {
    console.log(`| ${r.label} | LỖI | — | — |${money ? " — |" : ""} ${String(r.error).slice(0, 60)} |`);
    continue;
  }
  const sec = r.executeMs / 1000;
  const rel = baseline && r !== baseline
    ? `${(r.executeMs / baseline.executeMs).toFixed(2)}×`
    : "mốc";
  // s/bước tính trên số bước ĐẶT, không phải số bước thật chạy (EasyCache bỏ
  // bớt). Cột này để so LoRA-8-bước với gốc-14-bước cho công bằng.
  const perStep = r.steps ? (sec / r.steps).toFixed(1) : "—";
  // RunPod tính tiền từ lúc worker khởi động, nên cộng cả queueMs.
  const cost = money
    ? ` $${(USD_PER_SEC * ((r.executeMs + (r.queueMs ?? 0)) / 1000)).toFixed(3)} |`
    : "";
  console.log(`| ${r.label} | ${sec.toFixed(0)}s | ${perStep} | ${rel} |${cost} ${r.url ?? ""} |`);
}

if (!money) {
  console.log("\n(Đặt USD_PER_SEC để có thêm cột $/video — ví dụ Pod 5090: USD_PER_SEC=0.000275)");
}
console.log(`\nKết quả thô: ${OUT}`);
console.log("Giờ mở các link video xem cạnh nhau — bảng này chỉ nói tốc độ, không nói chất lượng.");
console.log("Với cấu hình turbo, xem kỹ: chuyển động có mềm quá không, và AUDIO có méo không.");
