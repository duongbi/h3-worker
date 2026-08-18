/**
 * Gửi một job thật lên RunPod Serverless endpoint và chờ kết quả.
 *
 *   node --env-file=.env scripts/test-endpoint.mjs "prompt của bạn"
 *
 * Cần trong .env (hoặc export):
 *   RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
 *
 * Tuỳ chọn qua biến môi trường:
 *   DURATION=10        số giây (4–15)
 *   ASPECT="9:16 (Portrait Widescreen)"
 *   MEGAPIXELS=1       1.0 ≈ 768p
 *   STEPS=20           giảm còn 10 để nhanh gấp đôi
 *   SEED=123456        để trống thì random
 *   JOB_ID=<id>        BỎ QUA submit, poll tiếp một job đã gửi trước đó
 *
 * Thí nghiệm tăng tốc (chèn node vào payload, KHÔNG sửa file workflow):
 *   EASYCACHE=0.2      bật node EasyCache, số là reuse_threshold (0 = tắt).
 *                      Càng cao càng nhanh, càng dễ mất chi tiết. 0.15–0.3 là vùng hay dùng.
 *   EASYCACHE_START=0.15 / EASYCACHE_END=0.95   khoảng % số bước được phép tái dùng
 *   COMPILE=1          bật node TorchCompileModel (backend inductor)
 *
 *   Đo một biến một lúc. Chạy chồng EASYCACHE với COMPILE ngay lần đầu thì
 *   không biết cái nào ăn, mà torch.compile còn hay phải compile lại khi
 *   EasyCache đổi đường chạy.
 *
 * ⚠ Cú pháp đặt biến khác nhau theo shell:
 *   Git Bash / WSL :  DURATION=4 STEPS=10 node --env-file=.env scripts/test-endpoint.mjs "..."
 *   PowerShell     :  $env:DURATION=4; $env:STEPS=10; node --env-file=.env scripts/test-endpoint.mjs "..."
 *   Đặt nhầm cú pháp thì script chạy với giá trị mặc định mà KHÔNG báo gì —
 *   luôn đọc dòng "→ Ns · NMP · N steps" in ra để xác nhận.
 */
import { readFile } from "node:fs/promises";

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT = process.env.RUNPOD_ENDPOINT_ID;
if (!API_KEY || !ENDPOINT) {
  console.error("✗ Thiếu RUNPOD_API_KEY hoặc RUNPOD_ENDPOINT_ID");
  process.exit(1);
}
const BASE = `https://api.runpod.ai/v2/${ENDPOINT}`;
const H = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// ---- Bản đồ node của h3_fl2va_api.json ----------------------------------
// ID có dấu hai chấm vì workflow dùng subgraph — giữ nguyên dạng chuỗi.
const NODE = {
  PROMPT: "105:104",   // MiniMaxH3ImageToVideo .prompt
  SEED: "105:15",      // RandomNoise         .noise_seed
  DURATION: "105:111", // PrimitiveFloat       .value  (giây)
  RESOLUTION: "115",   // ResolutionSelector   .aspect_ratio / .megapixels
  SCHEDULER: "105:9",  // BasicScheduler       .steps
  GUIDER: "105:16",    // BasicGuider          .model  ← chỗ cắm node tăng tốc
  SAVE: "92",          // SaveVideo            .filename_prefix
};

// ID cho node chèn thêm lúc chạy. Không được trùng ID có sẵn trong workflow.
const ACCEL_COMPILE = "acc:compile";
const ACCEL_EASYCACHE = "acc:easycache";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch có retry cho lỗi MẠNG (ETIMEDOUT, ECONNRESET, DNS...).
 *
 * Vì sao cần: một cú chớp mạng ở phía client từng giết cả script trong khi job
 * trên RunPod vẫn chạy bình thường — mất dấu job và tưởng là lỗi endpoint.
 * Lỗi HTTP (4xx/5xx) KHÔNG retry ở đây, để caller tự quyết.
 */
async function fetchRetry(url, opts = {}, { tries = 5, label = "request" } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      const cause = e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.message;
      if (i < tries) {
        const wait = Math.min(2 ** i, 30);
        console.log(`  ⚠ lỗi mạng khi ${label} (${cause}) — thử lại sau ${wait}s [${i}/${tries - 1}]`);
        await sleep(wait * 1000);
      }
    }
  }
  throw lastErr;
}

// ---- Gửi job (hoặc bám vào job đã có) ------------------------------------
let id = process.env.JOB_ID;

if (id) {
  console.log(`→ endpoint  ${ENDPOINT}`);
  console.log(`→ bám vào job đã gửi: ${id}\n`);
} else {
  const prompt = process.argv[2] ??
    "A calm seaside at golden hour, gentle waves, a lone sailboat drifting. " +
    "Audio: soft waves, distant seagulls, warm ambient pad.";

  const wf = JSON.parse(await readFile(new URL("../workflows/h3_fl2va_api.json", import.meta.url), "utf8"));

  // Kiểm tra bản đồ node còn khớp — workflow export lại là ID đổi hết.
  for (const [name, nid] of Object.entries(NODE)) {
    if (!wf[nid]) {
      console.error(`✗ Không tìm thấy node ${nid} (${name}) trong workflow.`);
      console.error("  Bạn vừa export lại workflow? Chạy: python scripts/inspect_workflow.py workflows/h3_fl2va_api.json");
      process.exit(1);
    }
  }

  const seed = Number(process.env.SEED) || Math.floor(Math.random() * 2 ** 48);
  wf[NODE.PROMPT].inputs.prompt = prompt;
  wf[NODE.SEED].inputs.noise_seed = seed;
  wf[NODE.DURATION].inputs.value = Number(process.env.DURATION ?? 10);
  wf[NODE.RESOLUTION].inputs.megapixels = Number(process.env.MEGAPIXELS ?? 1);
  if (process.env.ASPECT) wf[NODE.RESOLUTION].inputs.aspect_ratio = process.env.ASPECT;
  if (process.env.STEPS) wf[NODE.SCHEDULER].inputs.steps = Number(process.env.STEPS);

  // ---- Node tăng tốc, chèn lúc gửi ---------------------------------------
  // Chèn ở đây thay vì sửa h3_fl2va_api.json để mỗi lần đo chỉ khác nhau một
  // biến, và không phải commit/revert JSON sau mỗi thí nghiệm.
  //
  // Chỉ nối vào BasicGuider. BasicScheduler cũng nhận `model` nhưng chỉ dùng để
  // tính sigmas, không chạy forward — nối vào đó không nhanh thêm được gì.
  const accel = [];
  let modelRef = wf[NODE.GUIDER].inputs.model;        // mặc định ["105:6", 0]

  if (process.env.COMPILE === "1") {
    wf[ACCEL_COMPILE] = {
      class_type: "TorchCompileModel",
      inputs: { model: modelRef, backend: "inductor" },
    };
    modelRef = [ACCEL_COMPILE, 0];
    accel.push("torch.compile");
  }

  const easycache = Number(process.env.EASYCACHE ?? 0);
  if (easycache > 0) {
    wf[ACCEL_EASYCACHE] = {
      class_type: "EasyCache",
      inputs: {
        model: modelRef,
        reuse_threshold: easycache,
        start_percent: Number(process.env.EASYCACHE_START ?? 0.15),
        end_percent: Number(process.env.EASYCACHE_END ?? 0.95),
        verbose: true,                 // log ComfyUI sẽ nói đã tái dùng mấy bước
      },
    };
    modelRef = [ACCEL_EASYCACHE, 0];
    accel.push(`EasyCache ${easycache}`);
  }

  wf[NODE.GUIDER].inputs.model = modelRef;

  const jobId = `test-${Date.now()}`;
  console.log(`→ endpoint  ${ENDPOINT}`);
  console.log(`→ prompt    ${prompt.slice(0, 70)}…`);
  console.log(`→ ${wf[NODE.DURATION].inputs.value}s · ${wf[NODE.RESOLUTION].inputs.megapixels}MP · ` +
              `${wf[NODE.SCHEDULER].inputs.steps} steps · seed ${seed}`);
  console.log(`→ tăng tốc  ${accel.length ? accel.join(" + ") : "không (bản gốc)"}\n`);

  const submit = await fetchRetry(`${BASE}/run`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      input: { workflow: wf, meta: { jobId }, output_prefix: "videos/test" },
      policy: { executionTimeout: 1_500_000, ttl: 3_600_000 },
    }),
  }, { label: "submit" });

  if (!submit.ok) {
    console.error(`✗ /run → ${submit.status}: ${await submit.text()}`);
    process.exit(1);
  }
  ({ id } = await submit.json());
  console.log(`✓ đã submit, RunPod job id = ${id}`);
  console.log("  Lần đầu sẽ RẤT lâu (pull image 17GB + nạp 35GB weights + sampling).");
  console.log(`  Mất kết nối cũng không sao — poll lại bằng:  JOB_ID=${id} node --env-file=.env scripts/test-endpoint.mjs\n`);
}

// ---- Poll tới khi xong ---------------------------------------------------
const t0 = Date.now();
let lastLine = "";
for (;;) {
  await sleep(10_000);

  let j;
  try {
    const res = await fetchRetry(`${BASE}/status/${id}`, { headers: H }, { tries: 6, label: "poll" });
    if (!res.ok) {
      console.log(`  ⚠ /status → HTTP ${res.status}, thử lại vòng sau`);
      continue;
    }
    j = await res.json();
  } catch (e) {
    // Hết lượt retry: KHÔNG thoát. Job vẫn chạy trên RunPod, mạng mới là thứ hỏng.
    console.log(`  ⚠ mất mạng kéo dài (${e.cause?.code ?? e.message}) — vẫn tiếp tục chờ`);
    continue;
  }

  const mins = ((Date.now() - t0) / 60_000).toFixed(1);

  if (j.status === "COMPLETED") {
    console.log(`\n✓ XONG sau ${mins} phút`);
    console.log(JSON.stringify(j.output?.timings ?? {}, null, 2));
    for (const v of j.output?.videos ?? []) {
      console.log(`\n  VIDEO  ${v.url}`);
      console.log(`         ${(v.sizeBytes / 1e6).toFixed(1)} MB · ${v.contentType}`);
    }
    for (const w of j.output?.warnings ?? []) console.log(`  ⚠ ${w}`);
    if (!j.output?.videos?.length) {
      console.log("\n  ⚠ Không có video trong output. Xem Workers → Logs trên RunPod console.");
      console.log(JSON.stringify(j.output, null, 2).slice(0, 2000));
    }
    break;
  }
  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(j.status)) {
    console.error(`\n✗ ${j.status} sau ${mins} phút`);
    console.error(JSON.stringify(j, null, 2).slice(0, 3000));
    process.exit(1);
  }

  const prog = j.output?.state ? ` (${j.output.state})` : "";
  const line = `  ${mins}m  ${j.status}${prog}`;
  if (line !== lastLine) { console.log(line); lastLine = line; }
}
