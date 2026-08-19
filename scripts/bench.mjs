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
 * Biến môi trường:
 *   SEED=42            mặc định 42 — cố định để so ảnh
 *   DURATION=10        áp cho mọi cấu hình
 *   ASPECT=...         áp cho mọi cấu hình
 *   COMPILE=1          bật torch.compile cho mọi cấu hình
 *   IMAGE=... IMAGE_LAST=...   chạy cả loạt ở chế độ I2V
 *   CONFIGS='[{...}]'  JSON thay bộ cấu hình mặc định. Mỗi phần tử nhận
 *                      { label, megapixels, steps, easycache, compile }
 *   OUT=bench.json     nơi ghi kết quả thô (mặc định bench-results.json)
 *
 * Chi phí: mỗi cấu hình là một job thật. Bộ mặc định 5 cấu hình, ước chừng
 * 20–30 phút GPU. Đọc kỹ bảng trước khi chạy lại.
 */
import { readFile, writeFile } from "node:fs/promises";
import { buildWorkflow } from "./build-workflow.mjs";

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT = process.env.RUNPOD_ENDPOINT_ID;
if (!API_KEY || !ENDPOINT) {
  console.error("✗ Thiếu RUNPOD_API_KEY hoặc RUNPOD_ENDPOINT_ID");
  process.exit(1);
}
const BASE = `https://api.runpod.ai/v2/${ENDPOINT}`;
const H = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// Bộ mặc định: trả lời đúng câu "hạ độ phân giải và steps tới đâu thì còn đẹp".
// Cấu hình đầu là mốc so sánh, giữ nguyên để mọi lần chạy đều có gốc.
const DEFAULT_CONFIGS = [
  { label: "gốc 1MP·20",  megapixels: 1.0,  steps: 20, easycache: 0.2 },
  { label: "0.7MP·20",    megapixels: 0.7,  steps: 20, easycache: 0.2 },
  { label: "0.7MP·14",    megapixels: 0.7,  steps: 14, easycache: 0.2 },
  { label: "0.7MP·12",    megapixels: 0.7,  steps: 12, easycache: 0.2 },
  { label: "0.5MP·12",    megapixels: 0.5,  steps: 12, easycache: 0.2 },
];

const CONFIGS = process.env.CONFIGS ? JSON.parse(process.env.CONFIGS) : DEFAULT_CONFIGS;
const SEED = Number(process.env.SEED ?? 42);
const OUT = process.env.OUT ?? "bench-results.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        console.log(`    ⚠ lỗi mạng khi ${label} (${cause}) — thử lại sau ${wait}s`);
        await sleep(wait * 1000);
      }
    }
  }
  throw lastErr;
}

/** Gửi một job rồi chờ xong. Trả về {ok, executeMs, totalMs, url, error}. */
async function runOne(baseWf, cfg, prompt) {
  const { wf, assets, label } = buildWorkflow(baseWf, {
    ...cfg,
    prompt,
    seed: SEED,
    duration: process.env.DURATION ?? 10,
    aspect: process.env.ASPECT,
    compile: cfg.compile ?? process.env.COMPILE === "1",
    firstFrame: process.env.IMAGE,
    lastFrame: process.env.IMAGE_LAST,
  });

  console.log(`\n▶ ${cfg.label}`);
  console.log(`  ${label} · seed ${SEED}`);

  const submit = await fetchRetry(`${BASE}/run`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      input: { workflow: wf, assets, meta: { jobId: cfg.label }, output_prefix: "videos/bench" },
      policy: { executionTimeout: 1_500_000, ttl: 3_600_000 },
    }),
  }, { label: "submit" });

  if (!submit.ok) return { ok: false, error: `/run HTTP ${submit.status}: ${await submit.text()}` };

  const { id } = await submit.json();
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

console.log(`Quét ${CONFIGS.length} cấu hình trên endpoint ${ENDPOINT}`);
console.log(`prompt: ${prompt.slice(0, 70)}…`);
console.log(`seed cố định: ${SEED}\n`);
console.log("Chạy tuần tự. Cứ để đó, kết quả in dần.");

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

console.log("\n\n=== KẾT QUẢ ===\n");
console.log("| cấu hình | execute | so với gốc | video |");
console.log("|---|---|---|---|");
for (const r of results) {
  if (!r.ok) {
    console.log(`| ${r.label} | LỖI | — | ${String(r.error).slice(0, 60)} |`);
    continue;
  }
  const s = (r.executeMs / 1000).toFixed(0) + "s";
  const rel = baseline && r !== baseline
    ? `${(r.executeMs / baseline.executeMs).toFixed(2)}×`
    : "gốc";
  console.log(`| ${r.label} | ${s} | ${rel} | ${r.url ?? ""} |`);
}

console.log(`\nKết quả thô: ${OUT}`);
console.log("Giờ mở các link video xem cạnh nhau — bảng này chỉ nói tốc độ, không nói chất lượng.");
