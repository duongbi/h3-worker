/**
 * Dựng payload workflow cho một job H3, từ file h3_fl2va_api.json gốc.
 *
 * Vì sao tách ra file riêng: test-endpoint.mjs (chạy 1 job) và bench.mjs (quét
 * nhiều cấu hình) phải dựng workflow y hệt nhau. Hai bản copy sẽ lệch nhau sau
 * vài lần sửa, và lúc đó mọi số đo so sánh đều vô nghĩa.
 *
 * Nguyên tắc: KHÔNG sửa file h3_fl2va_api.json. Mọi thay đổi đều chèn lúc gửi,
 * nên file gốc luôn là bản T2V sạch và mỗi lần đo chỉ khác đúng một biến.
 */

// ---- Bản đồ node của h3_fl2va_api.json ----------------------------------
// ID có dấu hai chấm vì workflow dùng subgraph — giữ nguyên dạng chuỗi.
export const NODE = {
  PROMPT: "105:104",   // MiniMaxH3ImageToVideo .prompt / .first_frame / .last_frame
  SEED: "105:15",      // RandomNoise           .noise_seed
  DURATION: "105:111", // PrimitiveFloat        .value  (giây)
  RESOLUTION: "115",   // ResolutionSelector    .aspect_ratio / .megapixels
  SCHEDULER: "105:9",  // BasicScheduler        .steps
  GUIDER: "105:16",    // BasicGuider           .model  ← chỗ cắm node tăng tốc
  UNET: "105:6",       // UNETLoader            .unet_name ← đổi bản lượng tử hoá
  SAVE: "92",          // SaveVideo             .filename_prefix
};

// ID cho node chèn thêm lúc chạy. Không được trùng ID có sẵn trong workflow.
export const ACCEL_LORA = "acc:lora";
export const ACCEL_COMPILE = "acc:compile";
export const ACCEL_EASYCACHE = "acc:easycache";
export const IMG_FIRST = "acc:first_frame";
export const IMG_LAST = "acc:last_frame";

/**
 * Kiểm tra bản đồ node còn khớp với file workflow.
 * Export lại workflow từ ComfyUI là ID đổi hết — bắt ở đây thì báo lỗi rõ ràng,
 * thay vì để job chạy 10 phút rồi chết vì thiếu node.
 */
export function checkNodeMap(wf) {
  const missing = Object.entries(NODE).filter(([, id]) => !wf[id]);
  if (missing.length) {
    const list = missing.map(([name, id]) => `${id} (${name})`).join(", ");
    throw new Error(
      `Không tìm thấy node ${list} trong workflow.\n` +
      "  Bạn vừa export lại workflow? Chạy: python scripts/inspect_workflow.py workflows/h3_fl2va_api.json\n" +
      "  rồi cập nhật NODE trong scripts/build-workflow.mjs."
    );
  }
}

/** Tên file an toàn cho ảnh tải về container, suy ra từ URL. */
function assetName(url, fallback) {
  try {
    const base = new URL(url).pathname.split("/").pop() || "";
    const clean = base.replace(/[^A-Za-z0-9._-]/g, "_");
    if (clean && /\.[A-Za-z0-9]{2,5}$/.test(clean)) return clean;
  } catch {
    // URL không parse được thì dùng tên mặc định — handler sẽ báo lỗi tải nếu URL hỏng
  }
  return fallback;
}

/**
 * @param {object} baseWf  workflow gốc (đã JSON.parse)
 * @param {object} cfg
 *   prompt, seed, duration, megapixels, aspect, steps,
 *   easycache, easycacheStart, easycacheEnd, compile,
 *   firstFrame (URL), lastFrame (URL)
 * @returns {{wf: object, assets: Array, label: string}}
 */
export function buildWorkflow(baseWf, cfg = {}) {
  const wf = structuredClone(baseWf);
  checkNodeMap(wf);

  const seed = cfg.seed ?? Math.floor(Math.random() * 2 ** 48);
  const duration = Number(cfg.duration ?? 10);
  const megapixels = Number(cfg.megapixels ?? 1);

  // ---- Bản lượng tử hoá của diffusion model ------------------------------
  // Đo được 22/08/2026: trên RTX 5090, `pruned_fp8_scaled` chạy 44.5 s/bước vì
  // 19983MB diffusion + 14956MB text encoder không vừa 31GB VRAM — aimdo phải
  // stream liên tục. Đổi sang `pruned_nvfp4` (12.5GB) là đòn bẩy lớn nhất, và
  // nó chỉ là đổi MỘT CHUỖI ở đây, không phải build lại image.
  // File phải có sẵn trên volume — `test-pod.mjs` liệt kê được.
  if (cfg.unet) wf[NODE.UNET].inputs.unet_name = cfg.unet;

  if (cfg.prompt) wf[NODE.PROMPT].inputs.prompt = cfg.prompt;
  wf[NODE.SEED].inputs.noise_seed = seed;
  wf[NODE.DURATION].inputs.value = duration;
  wf[NODE.RESOLUTION].inputs.megapixels = megapixels;
  if (cfg.aspect) wf[NODE.RESOLUTION].inputs.aspect_ratio = cfg.aspect;
  if (cfg.steps) wf[NODE.SCHEDULER].inputs.steps = Number(cfg.steps);

  // ---- Image to Video ----------------------------------------------------
  // `first_frame` / `last_frame` là input TUỲ CHỌN của MiniMaxH3ImageToVideo.
  // Không nối gì vào thì đúng là T2V — đó là lý do workflow gốc không có LoadImage.
  // Ảnh được gửi kèm trong `assets`, handler tải về /comfyui/input trước khi
  // queue prompt, nên LoadImage chỉ cần đúng tên file.
  const assets = [];
  const modes = [];

  if (cfg.firstFrame) {
    const name = assetName(cfg.firstFrame, "first_frame.png");
    assets.push({ name, url: cfg.firstFrame });
    wf[IMG_FIRST] = { class_type: "LoadImage", inputs: { image: name } };
    wf[NODE.PROMPT].inputs.first_frame = [IMG_FIRST, 0];
    modes.push("first");
  }
  if (cfg.lastFrame) {
    const name = assetName(cfg.lastFrame, "last_frame.png");
    assets.push({ name, url: cfg.lastFrame });
    wf[IMG_LAST] = { class_type: "LoadImage", inputs: { image: name } };
    wf[NODE.PROMPT].inputs.last_frame = [IMG_LAST, 0];
    modes.push("last");
  }

  // ---- Node tăng tốc -----------------------------------------------------
  // Chỉ nối vào BasicGuider. BasicScheduler cũng nhận `model` nhưng chỉ dùng để
  // tính sigmas, không chạy forward — nối vào đó không nhanh thêm được gì.
  const accel = [];
  let modelRef = wf[NODE.GUIDER].inputs.model;

  // ---- Turbo LoRA --------------------------------------------------------
  // Bản distill của Lightx2v/ModelTC: 8 bước (hoặc 4 ở bản 768p) cho chất lượng
  // xấp xỉ 20 bước gốc. Đây là đòn bẩy tốc độ lớn nhất, vì nó cắt thẳng số lần
  // forward chứ không phải làm mỗi lần forward nhanh hơn.
  //
  // PHẢI đứng ĐẦU chuỗi: LoRA vá trọng số của model, còn compile/EasyCache thì
  // bọc bên ngoài. Đảo thứ tự là compile một model rồi mới vá — ComfyUI sẽ
  // phải biên dịch lại, hoặc tệ hơn là vá vào bản đã đóng băng.
  //
  // Nối cả vào BasicScheduler: node đó đọc `model_sampling` để dựng sigmas, và
  // LoRA distill có thể đổi shift. Đây là ngoại lệ của ghi chú ngay phía trên —
  // ta nối vì tính ĐÚNG sigmas, không phải vì tốc độ.
  if (cfg.lora) {
    wf[ACCEL_LORA] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: modelRef,
        lora_name: cfg.lora,
        strength_model: Number(cfg.loraStrength ?? 1.0),
      },
    };
    modelRef = [ACCEL_LORA, 0];
    wf[NODE.SCHEDULER].inputs.model = modelRef;
    accel.push(`LoRA ${cfg.lora}@${Number(cfg.loraStrength ?? 1.0)}`);
  }

  if (cfg.compile) {
    wf[ACCEL_COMPILE] = {
      class_type: "TorchCompileModel",
      inputs: { model: modelRef, backend: "inductor" },
    };
    modelRef = [ACCEL_COMPILE, 0];
    accel.push("torch.compile");
  }

  const easycache = Number(cfg.easycache ?? 0);
  if (easycache > 0) {
    wf[ACCEL_EASYCACHE] = {
      class_type: "EasyCache",
      inputs: {
        model: modelRef,
        reuse_threshold: easycache,
        start_percent: Number(cfg.easycacheStart ?? 0.15),
        end_percent: Number(cfg.easycacheEnd ?? 0.95),
        verbose: true,             // log ComfyUI sẽ nói bỏ qua được mấy bước
      },
    };
    modelRef = [ACCEL_EASYCACHE, 0];
    accel.push(`EasyCache ${easycache}`);
  }

  wf[NODE.GUIDER].inputs.model = modelRef;

  // Tên unet LUÔN nằm trong label. Bài học 19/08: hai lần đo lệch 40% mà không
  // quy được nguyên nhân vì label không nói chạy weights nào trên card nào.
  const unetShort = String(wf[NODE.UNET].inputs.unet_name || "")
    .replace(/^minimax_h3_fl2va_/, "").replace(/\.safetensors$/, "");

  const label =
    `${duration}s · ${megapixels}MP · ${wf[NODE.SCHEDULER].inputs.steps} steps · ${unetShort}` +
    (modes.length ? ` · I2V(${modes.join("+")})` : " · T2V") +
    (accel.length ? ` · ${accel.join(" + ")}` : "");

  return { wf, assets, label, seed };
}

/** Đọc cấu hình từ biến môi trường — dùng chung cho cả hai script. */
export function cfgFromEnv(env = process.env) {
  return {
    seed: env.SEED ? Number(env.SEED) : undefined,
    duration: env.DURATION ?? 10,
    megapixels: env.MEGAPIXELS ?? 1,
    aspect: env.ASPECT,
    steps: env.STEPS,
    // LORA="minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors" STEPS=8 EASYCACHE=0
    unet: env.UNET,
    lora: env.LORA,
    loraStrength: env.LORA_STRENGTH,
    easycache: env.EASYCACHE ?? 0,
    easycacheStart: env.EASYCACHE_START,
    easycacheEnd: env.EASYCACHE_END,
    compile: env.COMPILE === "1",
    firstFrame: env.IMAGE,
    lastFrame: env.IMAGE_LAST,
  };
}
