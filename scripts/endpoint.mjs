/**
 * Nơi DUY NHẤT quyết định script nói chuyện với ai: RunPod Serverless hay Pod.
 *
 * Trước đây `test-endpoint.mjs` và `bench.mjs` mỗi bên tự dựng BASE + headers +
 * fetchRetry. Ba bản copy đó sẽ lệch nhau ngay lần đầu thêm Pod vào, và lúc đó
 * mọi số đo so sánh giữa hai môi trường đều vô nghĩa. Gom về đây.
 *
 * Chọn đích theo .env — KHÔNG có cờ dòng lệnh, để một lần đặt là mọi script
 * cùng trỏ về một chỗ:
 *
 *   Pod:         RUNPOD_BASE_URL=https://<podId>-8000.proxy.runpod.net
 *                RUNPOD_API_KEY=<POD_API_KEY đã đặt trên Pod>
 *   Serverless:  RUNPOD_ENDPOINT_ID=3tody6vyko2zgd
 *                RUNPOD_API_KEY=<API key của tài khoản RunPod>
 *
 * Đặt cả hai thì Pod thắng. Muốn quay lại Serverless: comment RUNPOD_BASE_URL.
 */

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const BASE_URL_OVERRIDE = (process.env.RUNPOD_BASE_URL ?? "").replace(/\/+$/, "");

export const IS_POD = Boolean(BASE_URL_OVERRIDE);
export const BASE = BASE_URL_OVERRIDE || `https://api.runpod.ai/v2/${ENDPOINT_ID}`;
export const TARGET = IS_POD ? `POD ${BASE}` : `SERVERLESS ${ENDPOINT_ID}`;
export const HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

/** Gọi ở đầu mỗi script. Thoát ngay nếu cấu hình thiếu, thay vì lỗi 401 khó hiểu. */
export function requireConfig() {
  if (!API_KEY) {
    console.error("✗ Thiếu RUNPOD_API_KEY.");
    console.error("  Pod        → đặt bằng POD_API_KEY bạn khai trên Pod.");
    console.error("  Serverless → đặt bằng API key của tài khoản RunPod.");
    process.exit(1);
  }
  if (!IS_POD && !ENDPOINT_ID) {
    console.error("✗ Thiếu RUNPOD_ENDPOINT_ID (và cũng không có RUNPOD_BASE_URL).");
    console.error("  Chạy trên Pod thì đặt: RUNPOD_BASE_URL=https://<podId>-8000.proxy.runpod.net");
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch có retry cho lỗi MẠNG (ETIMEDOUT, ECONNRESET, DNS…).
 *
 * Vì sao cần: một cú chớp mạng phía client từng giết cả script trong khi job
 * trên RunPod vẫn chạy bình thường — mất dấu job và tưởng là lỗi endpoint.
 *
 * Với Pod còn một ca nữa: proxy của RunPod trả **502/503** trong lúc Pod đang
 * khởi động hoặc vừa restart. Đó là lỗi tạm, không phải lỗi của mình, nên retry
 * luôn — khác với Serverless, nơi mọi lỗi HTTP đều để caller tự quyết.
 */
export async function fetchRetry(url, opts = {}, { tries = 5, label = "request" } = {}) {
  // Retry một POST đã tới nơi = tạo job trùng. Ngày 22/08/2026 một lượt bench 4
  // cấu hình đẻ ra 6 job vì chỗ này retry `POST /run`. Chỉ cho retry POST khi
  // request mang Idempotency-Key — lúc đó Pod trả lại đúng job cũ.
  const isPost = String(opts.method || "GET").toUpperCase() === "POST";
  const hasIdem = Boolean(opts.headers?.["Idempotency-Key"]);
  const safeToRetry = !isPost || hasIdem;
  if (!safeToRetry) tries = 1;

  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (IS_POD && [502, 503, 504].includes(res.status) && i < tries) {
        const wait = Math.min(2 ** i, 30);
        console.log(`  ⚠ Pod trả HTTP ${res.status} khi ${label} (đang khởi động?) — thử lại sau ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      return res;
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

/**
 * Gửi một job. Nơi DUY NHẤT được phép gọi `POST /run`.
 *
 * Sinh một Idempotency-Key cho mỗi lần gọi, nên retry (proxy RunPod hay trả
 * 502/503 lúc Pod bận) trả lại ĐÚNG job cũ thay vì đẻ job mới. Không có nó thì
 * một lượt bench 4 cấu hình có thể ra 6 job — đã xảy ra thật 22/08/2026, và hai
 * job thừa hỏng với thông báo chỉ sai đường ("SaveVideo bị mute").
 *
 * Serverless bỏ qua header lạ nên vẫn chạy bình thường; ở đó RunPod tự chống
 * trùng theo cách riêng của họ.
 *
 * @returns {Promise<{id: string, status: string}>}
 */
export async function submitJob(body, { label = "submit" } = {}) {
  const res = await fetchRetry(BASE + "/run", {
    method: "POST",
    headers: { ...HEADERS, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  }, { label });

  if (!res.ok) {
    throw new Error(`/run → HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error(`/run không trả về job id: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/**
 * Hỏi /health trước khi tốn tiền GPU.
 *
 * Trên Pod, `comfy.report` chính là dòng `GPU=<tên> <VRAM>GB · torch=… · driver=…`
 * mà handler.py in ra. Đọc nó TRƯỚC khi bench là cách duy nhất để về sau quy được
 * số đo về đúng card — bài học 18–19/08: hai lần đo lệch 40% mà không biết vì sao.
 *
 * @returns {Promise<{ok: boolean, body: any, http: number}>}
 */
export async function health({ quiet = false } = {}) {
  const res = await fetchRetry(`${BASE}/health`, { headers: HEADERS }, { label: "health" });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { raw: "(không phải JSON)" };
  }
  if (!quiet) {
    if (IS_POD) {
      const c = body?.comfy ?? {};
      console.log(`  ComfyUI : ${c.ok ? "sẵn sàng" : `CHƯA sẵn sàng (${c.error ?? c.http ?? "?"})`}`);
      if (c.report) console.log(`  ${c.report}`);
      const w = body?.workers ?? {};
      const j = body?.jobs ?? {};
      console.log(`  Worker  : ${w.idle ?? "?"} rảnh / ${w.running ?? "?"} đang chạy`);
      console.log(`  Job     : ${j.inQueue ?? 0} đợi · ${j.inProgress ?? 0} chạy · ${j.completed ?? 0} xong · ${j.failed ?? 0} hỏng`);
    } else {
      console.log(`  ${JSON.stringify(body)}`);
    }
  }
  return { ok: res.ok, body, http: res.status };
}
