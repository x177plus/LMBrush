import { imageSizeFromBytes, checkReferenceSize } from "./image-size.js";

const $ = (selector) => document.querySelector(selector);

const EXAMPLES = [
  "戴圆眼镜的短发女孩，暖色调，窗边斜光",
  "一只橘猫坐在窗台上，窗外是夜空",
  "晨雾中的山谷，远山、松树和一条河",
  "穿宇航服的宇航员站在星球上",
];

const HISTORY_KEY = "lmbrush.history.v1";
const HISTORY_MAX = 4;
const REFERENCE_MAX_SIDE = 512;
const REFERENCE_MIN_SIDE = 8;
const REFERENCE_MAX_FILE = 20 * 1024 * 1024;

const state = {
  style: "auto",
  paintStyle: "classic",
  brush: 1,
  detail: false,
  variant: 0,
  stylePack: "none",
  busy: false,
  locked: false,
  phase: "生成中",
  reviewLabel: "",
  llm: false,
  vision: false,
  baseHint: "",
  localHint: "",
  referenceHint: "",
  referenceLocalHint: "",
  reference: null,
  referenceBusy: false,
  sourcePrompt: "",
  enriched: false,
  last: null,
  timer: null,
};

const els = {
  prompt: $("#prompt"),
  enrich: $("#enrich"),
  restore: $("#restore"),
  generate: $("#generate"),
  variant: $("#variant"),
  stage: $("#stage"),
  meta: $("#meta"),
  plan: $("#plan"),
  planSize: $("#planSize"),
  download: $("#download"),
  downloadPng: $("#downloadPng"),
  mode: $("#mode"),
  pack: $("#pack"),
  hint: $("#hint"),
  status: $("#status"),
  statusText: $("#statusText"),
  examples: $("#examples"),
  history: $("#history"),
  actions: $("#actions"),
  clearHistory: $("#clearHistory"),
  styleGroup: $("#styleGroup"),
  paintStyleGroup: $("#paintStyleGroup"),
  brushGroup: $("#brushGroup"),
  detailSwitch: $("#detailSwitch"),
  detailToggle: $("#detailToggle"),
  detailText: $("#detailText"),
  promptLabel: $("#promptLabel"),
  generateLabel: $("#generateLabel"),
  reference: $("#reference"),
  referenceInput: $("#referenceInput"),
  referenceDrop: $("#referenceDrop"),
  referencePicked: $("#referencePicked"),
  referencePreview: $("#referencePreview"),
  referenceName: $("#referenceName"),
  referenceSize: $("#referenceSize"),
  removeReference: $("#removeReference"),
};

init();

function init() {
  els.examples.innerHTML = "";
  for (const text of EXAMPLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", () => {
      els.prompt.value = text;
      state.sourcePrompt = text;
      state.enriched = false;
      resetVariant();
      els.prompt.focus();
      syncVariant();
    });
    els.examples.append(button);
  }

  els.styleGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-style]");
    if (!button) return;
    state.style = button.dataset.style;
    markPressed(els.styleGroup, button);
  });

  els.generate.addEventListener("click", () => generate());
  els.enrich?.addEventListener("click", () => enrich());
  els.restore?.addEventListener("click", () => restorePrompt());
  els.pack?.addEventListener("change", () => {
    state.stylePack = els.pack.value;
    resetVariant();
  });
  els.variant?.addEventListener("click", () => {
    if (state.busy) return;
    generate({ forceNew: true });
  });
  els.prompt.addEventListener("input", () => {
    state.sourcePrompt = els.prompt.value;
    state.enriched = false;
    resetVariant();
    syncVariant();
  });
  els.prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      generate();
    }
  });
  els.brushGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-brush]");
    if (!button) return;
    state.brush = Number(button.dataset.brush);
    markPressed(els.brushGroup, button);
  });
  els.paintStyleGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-paint-style]");
    if (!button) return;
    state.paintStyle = button.dataset.paintStyle;
    markPressed(els.paintStyleGroup, button);
  });
  els.detailToggle.addEventListener("change", () => {
    state.detail = els.detailToggle.checked;
    syncDetailToggle();
  });
  els.mode.addEventListener("change", () => {
    if (els.mode.value === "local" && state.detail) {
      state.detail = false;
      els.detailToggle.checked = false;
    }
    syncReferenceControls();
    if (state.reference && !state.busy) {
      els.hint.classList.remove("warn");
      els.hint.textContent = referenceHintForMode() || "";
    } else if (!state.busy) {
      els.hint.classList.remove("warn");
      els.hint.textContent = els.mode.value === "local" ? state.localHint : state.baseHint;
    }
  });

  els.referenceInput.addEventListener("change", () => {
    const file = els.referenceInput.files && els.referenceInput.files[0];
    els.referenceInput.value = "";
    if (file) loadReference(file);
  });
  els.referenceDrop.addEventListener("click", () => {
    if (!els.referenceInput.disabled) els.referenceInput.click();
  });
  for (const event of ["dragenter", "dragover"]) {
    els.reference.addEventListener(event, (event_) => {
      event_.preventDefault();
      if (!state.busy && !state.referenceBusy) els.reference.classList.add("dragging");
    });
  }
  for (const event of ["dragleave", "dragend", "drop"]) {
    els.reference.addEventListener(event, (event_) => {
      event_.preventDefault();
      els.reference.classList.remove("dragging");
    });
  }
  els.reference.addEventListener("drop", (event_) => {
    const file = event_.dataTransfer && event_.dataTransfer.files && event_.dataTransfer.files[0];
    if (file && !state.busy) loadReference(file);
  });
  els.removeReference.addEventListener("click", () => {
    if (state.busy) return;
    state.reference = null;
    resetVariant();
    syncReferenceUi();
    els.hint.classList.remove("warn");
    els.hint.textContent = "已移除参考图。可以重新描述画面，或再上传一张。";
    els.prompt.focus();
  });

  els.download.addEventListener("click", download);
  els.downloadPng.addEventListener("click", downloadPng);
  els.clearHistory.addEventListener("click", () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory([]);
  });

  checkHealth();
  renderHistory(loadHistory());
  state.sourcePrompt = els.prompt.value;
  state.enriched = false;
  syncVariant();
  syncReferenceUi();
  els.prompt.focus();
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    state.llm = Boolean(data.llm && data.llm.configured);
    state.vision = Boolean(data.vision && data.vision.configured);
    const localReferenceHint = "参考图会在本地解析色彩区块再重绘；描述里的色调词（暖色调、冷色调、黑白、高对比、更亮等）会整体调色，构图保持不变。";
    state.referenceLocalHint = state.vision
      ? `${localReferenceHint} 切到“自动”或“只用 LLM”可用视觉模型理解更自由的说法。`
      : `${localReferenceHint} 配置 VISION_MODEL 可启用视觉解析。`;
    state.referenceHint = state.vision
      ? "参考图先由视觉模型解析主体，再按参考图的颜色和构图重绘；描述可以整体调色（暖/冷、黑白、明暗、饱和度、色相），构图保持不变。"
      : state.referenceLocalHint;
    if (els.enrich) {
      els.enrich.hidden = !state.llm;
      els.enrich.title = state.llm
        ? "让 LLM 把当前描述随机扩展成更丰富的画面提示"
        : "需要配置 LLM 才能润色描述";
    }
    const auth = data.auth || {};
    state.locked = Boolean(auth.required) && !auth.authenticated;
    syncVariant();
    syncReferenceUi();
    fillStylePacks(data.stylePacks);
    if (state.locked) {
      els.generate.disabled = true;
      setStatus("error", "需要访问口令");
      els.hint.textContent = "此演示需要访问口令。请用部署者提供的 /api/login?token=… 链接打开一次，再回到此页面生成。";
      els.hint.classList.add("warn");
      return;
    }
    if (state.reference) {
      els.hint.textContent = referenceHintForMode();
      els.hint.classList.remove("warn");
    }
    if (data.llm && data.llm.configured) {
      setStatus("llm", data.llm.model ? `LLM · ${data.llm.model}` : "LLM");
      state.baseHint = "LLM 把描述转成绘制计划。每次生成会换构图和配色；“丰富细节”会额外调用 LLM 给主要物体补局部。";
      state.localHint = "当前选择只用本地规则，不调用模型。切到“自动”或“只用 LLM”可使用已配置的模型。";
      if (data.vision && data.vision.configured) {
        state.baseHint = `${state.baseHint} 视觉评审已启用${data.vision.model ? `（${data.vision.model}）` : ""}。`;
      }
      els.hint.textContent = state.reference ? referenceHintForMode() : state.baseHint;
    } else {
      setStatus("local", "本地规则模式");
      state.baseHint = "未配置 LLM，当前使用内置规则生成。设置 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 后重启即可启用。";
      state.localHint = state.baseHint;
      els.hint.textContent = state.reference ? referenceHintForMode() : state.baseHint;
      els.hint.classList.toggle("warn", !state.reference);
    }
  } catch {
    state.llm = false;
    state.vision = false;
    state.referenceHint = "参考图会在本地解析色彩区块，再按笔触重绘；描述里的常见色调词会整体调色，构图不变。";
    state.referenceLocalHint = state.referenceHint;
    if (els.enrich) els.enrich.hidden = true;
    setStatus("error", "服务不可用");
  }
}

function setStatus(kind, text) {
  els.status.dataset.state = kind;
  els.statusText.textContent = text;
}

function referenceHintForMode() {
  return els.mode.value === "local" ? state.referenceLocalHint : state.referenceHint;
}

function markPressed(group, activeButton) {
  for (const button of group.querySelectorAll("button")) {
    const pressed = button === activeButton;
    button.classList.toggle("on", pressed);
    button.setAttribute("aria-pressed", String(pressed));
  }
}

function fillStylePacks(packs) {
  if (!els.pack || !Array.isArray(packs)) return;
  const current = els.pack.value;
  els.pack.innerHTML = '<option value="none">不指定</option>';
  for (const pack of packs) {
    if (!pack || typeof pack.id !== "string") continue;
    const option = document.createElement("option");
    option.value = pack.id;
    option.textContent = pack.label || pack.id;
    els.pack.append(option);
  }
  els.pack.value = packs.some((pack) => pack && pack.id === current) ? current : "none";
  state.stylePack = els.pack.value;
}

/* ----------------------------------------------------------------- reference */

async function loadReference(file) {
  if (state.busy || state.referenceBusy) return;
  if (!isImageFile(file)) {
    setReferenceError("请选择 PNG、JPEG、WebP 或其他图片文件");
    return;
  }
  if (file.size > REFERENCE_MAX_FILE) {
    setReferenceError("参考图文件过大（最多 20 MB）");
    return;
  }

  state.referenceBusy = true;
  syncReferenceUi();
  els.hint.classList.remove("warn");
  els.hint.textContent = "正在读取参考图…";

  try {
    const size = await probeImageSize(file);
    const sizeError = checkReferenceSize(size);
    if (sizeError) {
      setReferenceError(sizeError);
      return;
    }

    const loaded = await decodeImage(file);
    try {
      const { width, height } = fitReferenceSize(loaded.width, loaded.height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(loaded.source, 0, 0, width, height);

      const imageData = context.getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < imageData.length; i += 4, j += 3) {
        rgb[j] = imageData[i];
        rgb[j + 1] = imageData[i + 1];
        rgb[j + 2] = imageData[i + 2];
      }

      state.reference = {
        name: file.name || "reference",
        width,
        height,
        data: rgbBase64(rgb),
        key: `${width}x${height}:${hashBytes(rgb).toString(16)}`,
        preview: canvas.toDataURL("image/jpeg", 0.82),
      };
      resetVariant();
      syncReferenceUi();
      els.hint.classList.remove("warn");
      els.hint.textContent = referenceHintForMode() || "参考图已读取，可以点“重绘参考图”。";
    } finally {
      loaded.release();
    }
  } catch (error) {
    state.reference = null;
    syncReferenceUi();
    setReferenceError(`参考图读取失败：${error.message}`);
  } finally {
    state.referenceBusy = false;
    syncReferenceUi();
    syncVariant();
  }
}

async function probeImageSize(file) {
  try {
    return imageSizeFromBytes(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }
}

function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" }).then((bitmap) => ({
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close && bitmap.close(),
    })).catch(() => decodeWithImageElement(file));
  }
  return decodeWithImageElement(file);
}

async function decodeWithImageElement(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("浏览器无法解码这张图片"));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || "");
}

/* Keeps the upload small enough to travel as JSON while preserving detail for
 * the fine brush. The long side is capped at 512; tiny images are upscaled to
 * the server minimum instead of being rejected. */
function fitReferenceSize(width, height) {
  if (!width || !height) throw new Error("图片尺寸为空");
  const aspect = width / height;
  if (aspect > 7.5 || aspect < 1 / 7.5) {
    throw new Error("图片长宽比需在 1:7.5 到 7.5:1 之间");
  }
  const longest = Math.max(width, height);
  let scale = Math.min(1, REFERENCE_MAX_SIDE / longest);
  if (Math.min(width, height) * scale < REFERENCE_MIN_SIDE) {
    scale = REFERENCE_MIN_SIDE / Math.min(width, height);
  }
  return {
    width: Math.max(REFERENCE_MIN_SIDE, Math.round(width * scale)),
    height: Math.max(REFERENCE_MIN_SIDE, Math.round(height * scale)),
  };
}

function rgbBase64(rgb) {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < rgb.length; i += chunk) {
    binary += String.fromCharCode(...rgb.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function syncReferenceUi() {
  const reference = state.reference;
  const busy = state.busy || state.referenceBusy;
  if (reference) {
    els.referenceDrop.hidden = true;
    els.referencePicked.hidden = false;
    if (els.referencePreview.src !== reference.preview) {
      els.referencePreview.src = reference.preview;
    }
    els.referenceName.textContent = reference.name;
    els.referenceSize.textContent = `${reference.width} × ${reference.height} 像素`;
    els.promptLabel.textContent = "描述（可选）";
    els.prompt.placeholder = "可选：说明重点，或调色（暖色调 / 黑白 / 更亮 / 低饱和）";
    els.generateLabel.textContent = "重绘参考图";
  } else {
    els.referenceDrop.hidden = false;
    els.referencePicked.hidden = true;
    els.promptLabel.textContent = "描述你想要的画面";
    els.prompt.placeholder = "例如：戴圆眼镜的短发女孩，暖色调，窗边斜光";
    els.generateLabel.textContent = "生成画面";
  }
  els.referenceInput.disabled = busy;
  els.removeReference.disabled = busy || !reference;
  els.reference.classList.toggle("busy", busy);
  syncReferenceControls();
  if (!busy) syncVariant();
}

/* The style preset, rich-detail patches and style packs are plan-authoring
 * options; a reference repaint takes its colours from the image. Disable them
 * instead of silently ignoring the controls. */
function syncReferenceControls() {
  const referenceMode = Boolean(state.reference);
  const localMode = els.mode.value === "local";
  for (const button of els.styleGroup.querySelectorAll("button")) {
    button.disabled = referenceMode;
  }
  if (els.pack) {
    els.pack.disabled = referenceMode || localMode;
    els.pack.title = referenceMode
      ? "参考图重绘的配色来自图片；需要调色请在描述里说明（暖/冷、黑白、明暗等）"
      : localMode ? "本地规则模式不读取配色包" : "";
  }
  if (referenceMode) {
    els.detailToggle.disabled = true;
    els.detailSwitch.classList.add("disabled");
    els.detailText.textContent = "参考图模式不支持";
    els.detailToggle.title = "参考图由像素导引重绘，不需要局部细节补丁";
  } else {
    syncDetailToggle();
  }
}

function setReferenceError(message) {
  els.hint.textContent = message;
  els.hint.classList.add("warn");
}

async function enrich() {
  if (state.busy || !state.llm) return;
  if (state.locked) {
    setReferenceError("此演示需要访问口令。请用部署者提供的 /api/login?token=… 链接打开一次。");
    return;
  }
  const prompt = (state.sourcePrompt || els.prompt.value).trim();
  if (!prompt) {
    els.prompt.focus();
    return;
  }

  state.busy = true;
  els.generate.disabled = true;
  els.enrich.disabled = true;
  els.variant.disabled = true;
  if (els.restore) els.restore.disabled = true;
  const label = els.enrich.textContent;
  els.enrich.textContent = "润色中…";
  els.hint.classList.remove("warn");
  els.hint.textContent = "正在让 LLM 扩展描述…";

  try {
    const response = await fetch("/api/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, nonce: Date.now() }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.ok) {
      throw new Error((data && data.error) || `润色失败（${response.status}）`);
    }
    els.prompt.value = data.prompt;
    state.enriched = true;
    resetVariant();
    els.prompt.focus();
    els.hint.classList.remove("warn");
    els.hint.textContent = `已润色${data.model ? ` · ${data.model}` : ""}。再点一次会从原文重新扩展；也可以恢复原文。`;
  } catch (error) {
    els.hint.textContent = error.message;
    els.hint.classList.add("warn");
  } finally {
    state.busy = false;
    els.enrich.textContent = label;
    els.generate.disabled = state.locked;
    syncVariant();
  }
}

function restorePrompt() {
  if (!state.enriched) return;
  els.prompt.value = state.sourcePrompt;
  state.enriched = false;
  resetVariant();
  els.prompt.focus();
  els.hint.classList.remove("warn");
  els.hint.textContent = "已恢复原文。可以直接生成，或再润色。";
}

async function postPipeline(step, payload) {
  const response = await fetch("/api/pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, ...payload }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.ok) {
    throw new Error((data && data.error) || `请求失败（${response.status}）`);
  }
  return data;
}

function addUsage(total, extra) {
  if (!extra) return total;
  const base = total || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
  return {
    prompt_tokens: base.prompt_tokens + (Number(extra.prompt_tokens) || 0),
    completion_tokens: base.completion_tokens + (Number(extra.completion_tokens) || 0),
    total_tokens: base.total_tokens + (Number(extra.total_tokens) || 0),
    reasoning_tokens: base.reasoning_tokens + (Number(extra.reasoning_tokens) || 0),
  };
}

function addCost(total, extra) {
  if (!extra) return total;
  const base = total || { inputTokens: 0, outputTokens: 0, input: 0, output: 0, total: 0, unit: "USD" };
  return {
    inputTokens: base.inputTokens + (Number(extra.inputTokens) || 0),
    outputTokens: base.outputTokens + (Number(extra.outputTokens) || 0),
    input: base.input + (Number(extra.input) || 0),
    output: base.output + (Number(extra.output) || 0),
    total: base.total + (Number(extra.total) || 0),
    unit: "USD",
  };
}

async function renderOnly(payload, prompt, started) {
  const res = await postPipeline("render", {
    plan: state.last.plan,
    render: payload.render,
    paintStyle: payload.paintStyle,
    brush: payload.brush,
    variant: payload.variant,
  });
  if (!isSafeSvg(res.svg)) throw new Error("生成的 SVG 未通过安全检查");
  const meta = {
    ...(state.last.meta || {}),
    ...(res.meta || {}),
    variant: payload.variant,
    ms: performance.now() - started,
  };
  showResult({ plan: state.last.plan, svg: res.svg, meta }, prompt);
  saveHistory({ plan: state.last.plan, svg: res.svg, meta }, prompt);
}

async function runGeneratePipeline(payload, prompt, started) {
  let usage = null;
  let cost = null;
  const absorb = (meta) => {
    if (!meta) return;
    usage = addUsage(usage, meta.usage);
    cost = addCost(cost, meta.cost);
  };

  const planRes = await postPipeline("plan", {
    prompt: payload.prompt,
    style: payload.style,
    mode: payload.mode,
    variant: payload.variant,
    stylePack: payload.stylePack,
    detail: payload.detail,
  });
  let plan = planRes.plan;
  let focus = Array.isArray(planRes.focus) ? planRes.focus : [];
  let meta = { ...(planRes.meta || {}) };
  if (Number.isFinite(meta.variant)) state.variant = meta.variant;
  absorb(planRes.meta);

  const render = async () => {
    const res = await postPipeline("render", {
      plan,
      render: payload.render,
      paintStyle: payload.paintStyle,
      brush: payload.brush,
      variant: payload.variant,
    });
    if (!isSafeSvg(res.svg)) throw new Error("生成的 SVG 未通过安全检查");
    meta = { ...meta, ...(res.meta || {}) };
    return res.svg;
  };

  // Show the deterministic base image while optional stages refine it. The
  // download buttons stay hidden until the whole pipeline finishes.
  let svg = await render();
  const willCritique = state.vision && meta.mode === "llm";
  const willDetail = Boolean(payload.detail) && meta.mode === "llm";
  const willEnhance = willCritique || willDetail;
  if (willEnhance) {
    state.reviewLabel = willCritique ? "评审中" : "补充细节中";
    showResult(
      { plan, svg, meta: { ...meta, ms: performance.now() - started } },
      prompt,
      { pending: true, animate: true }
    );
    els.meta.textContent = `生成中 · ${((performance.now() - started) / 1000).toFixed(1)}s`;
  }

  if (willCritique) {
    try {
      const critRes = await postPipeline("critique", {
        plan,
        prompt: payload.prompt,
        stylePack: payload.stylePack,
      });
      absorb(critRes.meta);
      if (critRes.meta && critRes.meta.critique) meta.critique = critRes.meta.critique;
      if (critRes.meta && Number.isFinite(critRes.meta.criticMs)) meta.criticMs = critRes.meta.criticMs;
      if (critRes.repair) {
        try {
          const repairRes = await postPipeline("repair", {
            plan,
            critique: critRes.critique,
            prompt: payload.prompt,
            style: payload.style,
            stylePack: payload.stylePack,
          });
          absorb(repairRes.meta);
          if (repairRes.meta) {
            if (repairRes.meta.critique) meta.critique = { ...meta.critique, ...repairRes.meta.critique };
            if (Number.isFinite(repairRes.meta.criticRepairMs)) {
              meta.criticRepairMs = repairRes.meta.criticRepairMs;
            }
            if (repairRes.meta.criticRepair) meta.criticRepair = true;
            if (repairRes.meta.repairErrors) meta.critique.repairErrors = repairRes.meta.repairErrors;
            if (repairRes.meta.repairRejected) meta.critique.repairRejected = repairRes.meta.repairRejected;
            if (repairRes.meta.advisories) meta.advisories = repairRes.meta.advisories;
            if (repairRes.meta.aesthetic) meta.aesthetic = repairRes.meta.aesthetic;
          }
          if (repairRes.plan) {
            plan = repairRes.plan;
            svg = await render();
          }
        } catch (error) {
          meta.critique = { ...(meta.critique || {}), repairError: error.message };
        }
      }
    } catch (error) {
      meta.critique = { error: error.message };
    }
  }

  if (willDetail) {
    try {
      const detailRes = await postPipeline("detail", {
        plan,
        prompt: payload.prompt,
        focus,
        style: payload.style,
        stylePack: payload.stylePack,
      });
      absorb(detailRes.meta);
      if (detailRes.meta) {
        if (detailRes.meta.detail) meta.detail = detailRes.meta.detail;
        if (Number.isFinite(detailRes.meta.detailMs)) meta.detailMs = detailRes.meta.detailMs;
        if (detailRes.meta.advisories) meta.advisories = detailRes.meta.advisories;
        if (detailRes.meta.aesthetic) meta.aesthetic = detailRes.meta.aesthetic;
      }
      if (detailRes.plan) {
        plan = detailRes.plan;
        svg = await render();
      }
    } catch (error) {
      meta.detail = { requested: true, applied: false, reason: `细节补丁失败：${error.message}` };
    }
  }

  if (usage) meta.usage = usage;
  if (cost) meta.cost = cost;
  meta.variant = payload.variant;
  meta.ms = performance.now() - started;
  stopPaintAnimation();
  showResult({ plan, svg, meta }, prompt);
  saveHistory({ plan, svg, meta }, prompt);
}

async function generate({ forceNew = false } = {}) {
  if (state.busy || state.referenceBusy) return;
  if (state.locked) {
    showError("此演示需要访问口令。请用部署者提供的 /api/login?token=… 链接打开一次。");
    return;
  }
  const prompt = els.prompt.value.trim();
  const reference = state.reference;
  if (!prompt && !reference) {
    els.prompt.focus();
    return;
  }

  // A repeated request is a request for a new interpretation, not for the
  // cached copy. Changing only the renderer (paint style or brush size) keeps
  // the same variant so both styles can share one cached plan.
  const referenceKey = reference ? reference.key : "";
  const samePlanInputs = Boolean(state.last)
    && state.last.prompt === prompt
    && state.last.referenceKey === referenceKey
    && state.last.style === state.style
    && state.last.mode === els.mode.value
    && state.last.stylePack === state.stylePack
    && state.last.detail === state.detail;
  const renderOnlyChange = samePlanInputs
    && (state.last.paintStyle !== state.paintStyle || state.last.brush !== state.brush);
  if (forceNew || (state.last
      && state.last.prompt === prompt
      && state.last.referenceKey === referenceKey
      && !renderOnlyChange)) {
    state.variant = Math.min(999, state.variant + 1);
  }

  state.busy = true;
  els.generate.disabled = true;
  els.download.disabled = true;
  els.downloadPng.disabled = true;
  els.actions.hidden = true;
  stopPaintAnimation();
  state.phase = "生成中";
  state.reviewLabel = "";
  syncReferenceUi();
  els.stage.setAttribute("aria-busy", "true");
  if (els.stage.querySelector(".empty, .error")) {
    els.stage.innerHTML = '<div class="empty"><p>正在生成…</p></div>';
  }
  const started = performance.now();
  const tick = () => {
    els.meta.textContent = `${state.phase} · ${((performance.now() - started) / 1000).toFixed(1)}s`;
  };
  tick();
  state.timer = setInterval(tick, 150);

  try {
    const payload = reference
      ? {
          prompt,
          mode: els.mode.value,
          paintStyle: state.paintStyle,
          brush: state.brush,
          variant: state.variant,
          image: { w: reference.width, h: reference.height, data: reference.data },
        }
      : {
          prompt,
          style: state.style,
          paintStyle: state.paintStyle,
          render: "paint",
          mode: els.mode.value,
          brush: state.brush,
          variant: state.variant,
          stylePack: state.stylePack,
          detail: state.detail,
        };

    if (reference) {
      const response = await fetch("/api/repaint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.ok) {
        throw new Error((data && data.error) || `请求失败（${response.status}）`);
      }
      if (!isSafeSvg(data.svg)) throw new Error("生成的 SVG 未通过安全检查");
      if (data.meta && Number.isFinite(data.meta.variant)) state.variant = data.meta.variant;
      showResult(data, prompt);
      saveHistory(data, prompt);
    } else if (!forceNew && renderOnlyChange && state.last && state.last.plan) {
      await renderOnly(payload, prompt, started);
    } else {
      await runGeneratePipeline(payload, prompt, started);
    }
  } catch (error) {
    showError(error.message);
  } finally {
    clearInterval(state.timer);
    state.timer = null;
    state.busy = false;
    stopPaintAnimation();
    els.generate.disabled = state.locked;
    syncReferenceUi();
    els.stage.removeAttribute("aria-busy");
  }
}

function resetVariant() {
  state.variant = 0;
  syncVariant();
}

function syncVariant() {
  const empty = !els.prompt.value.trim() && !state.reference;
  const hasSource = Boolean(state.sourcePrompt.trim());
  if (els.variant) els.variant.disabled = state.busy || state.referenceBusy || empty;
  if (els.enrich) els.enrich.disabled = state.busy || !state.llm || !hasSource || state.locked;
  if (els.restore) {
    els.restore.hidden = !state.enriched;
    els.restore.disabled = state.busy || !state.enriched;
  }
  syncDetailToggle();
}

function syncDetailToggle() {
  if (!els.detailToggle) return;
  const referenceMode = Boolean(state.reference);
  const localMode = els.mode.value === "local";
  const unavailable = referenceMode || !state.llm || localMode;
  if (unavailable) {
    state.detail = false;
    els.detailToggle.checked = false;
  }
  els.detailToggle.disabled = state.busy || unavailable;
  els.detailSwitch.classList.toggle("disabled", els.detailToggle.disabled);

  if (referenceMode) {
    els.detailText.textContent = "参考图模式不支持";
    els.detailToggle.title = "参考图由像素导引重绘，不需要局部细节补丁";
  } else if (!state.llm) {
    els.detailText.textContent = "需要配置 LLM";
    els.detailToggle.title = "配置 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 后可用";
  } else if (localMode) {
    els.detailText.textContent = "本地模式不支持";
    els.detailToggle.title = "细节补丁需要调用 LLM，请切换生成方式";
  } else if (state.detail) {
    els.detailText.textContent = "开启 · 最多 2 次局部补丁";
    els.detailToggle.title = "为首轮标出的 1–2 个主要物体追加细节补丁";
  } else {
    els.detailText.textContent = "关闭 · 只生成一次";
    els.detailToggle.title = "开启后会为首轮标出的主要物体追加局部细节";
  }
}

function describeTone(tone, source) {
  if (!tone) return "";
  const parts = [];
  const num = (value) => Math.round(value * 100) / 100;
  if (tone.warmth >= 0.05) parts.push(`暖 +${num(tone.warmth)}`);
  else if (tone.warmth <= -0.05) parts.push(`冷 ${num(-tone.warmth)}`);
  if (tone.saturation <= 0.05) parts.push("黑白");
  else if (Math.abs(tone.saturation - 1) >= 0.05) parts.push(`饱和 ${num(tone.saturation)}`);
  if (tone.brightness >= 0.05) parts.push(`亮 +${num(tone.brightness)}`);
  else if (tone.brightness <= -0.05) parts.push(`暗 ${num(-tone.brightness)}`);
  if (Math.abs(tone.contrast - 1) >= 0.05) parts.push(`对比 ${num(tone.contrast)}`);
  if (Math.abs(tone.hue) >= 1) parts.push(`色相 ${num(tone.hue)}°`);
  if (!parts.length) return "";
  return `${source === "llm" ? "AI 调色" : "调色"} · ${parts.join(" · ")}`;
}

let paintFrame = null;

function startPaintAnimation() {
  stopPaintAnimation();
  const svg = els.stage.querySelector("svg");
  const groups = svg ? [...svg.querySelectorAll(".paint-batch")] : [];
  if (groups.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    if (state.busy && state.reviewLabel) state.phase = state.reviewLabel;
    return;
  }

  els.stage.classList.add("is-painting");
  for (const group of groups) group.classList.remove("is-painted");
  groups[0].classList.add("is-painted");

  let revealed = 1;
  const started = performance.now();
  const duration = Math.min(16000, Math.max(4000, groups.length * 100));

  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const target = Math.max(1, Math.ceil(progress * groups.length));
    for (let index = revealed; index < target; index++) {
      groups[index].classList.add("is-painted");
    }
    revealed = target;
    if (progress < 1) {
      paintFrame = requestAnimationFrame(step);
      return;
    }
    paintFrame = null;
    els.stage.classList.remove("is-painting");
    if (state.busy && state.reviewLabel) state.phase = state.reviewLabel;
  };
  paintFrame = requestAnimationFrame(step);
}

function stopPaintAnimation() {
  if (paintFrame !== null) {
    cancelAnimationFrame(paintFrame);
    paintFrame = null;
  }
  els.stage.classList.remove("is-painting");
}

function showResult(data, prompt, { pending = false, animate = false } = {}) {
  logComposition(data.plan, data.meta || {}, prompt);
  els.stage.innerHTML = data.svg;
  if (animate) startPaintAnimation();
  els.meta.title = "";
  const meta = data.meta || {};
  const isReference = Boolean(meta.reference);
  const bits = [meta.render === "paint"
    ? (meta.paintStyle === "blockin" ? "油画 · 色块铺陈" : "油画 · 经典笔触")
    : "扁平"];
  if (meta.strokes) bits.push(`${meta.strokes} 笔 · ${brushLabel(meta.brush)}`);
  if (isReference) {
    bits.push(`参考图 · ${meta.reference.regions || 0} 色块`);
    if (meta.analysisCached) bits.push("解析缓存");
    else if (meta.mode === "llm") bits.push("AI 解析");
    if (meta.focusStrokes) bits.push(`主体细节 ${meta.focusStrokes} 笔`);
    const toneLabel = describeTone(meta.tone, meta.toneSource);
    if (toneLabel) bits.push(toneLabel);
  }
  if (meta.detail && meta.detail.requested) {
    if (meta.detail.applied) {
      bits.push(`细节 ${meta.detail.regions || 0} 区 · +${meta.detail.elements || 0} 图元`);
      if (meta.detail.failed) bits.push(`${meta.detail.failed} 区失败`);
      if (meta.detail.warning) els.meta.title = meta.detail.warning;
    } else {
      bits.push("细节未应用");
      if (meta.detail.reason) els.meta.title = meta.detail.reason;
    }
  }
  bits.push(meta.mode === "llm"
    ? `${isReference ? "视觉解析" : "LLM"}${meta.model ? ` · ${meta.model}` : ""}`
    : (isReference ? "本地色彩解析" : "本地规则"));
  if (meta.variant) bits.push(`变体 ${meta.variant}`);
  if (meta.stylePack) bits.push(`配色 ${meta.stylePack}`);
  if (isReference && Array.isArray(meta.reference.focusBoxes) && meta.reference.focusBoxes.length) {
    const labels = meta.reference.focusBoxes.map((box) => box.label).filter(Boolean).join("、");
    if (labels) {
      const focusTitle = `视觉解析重点：${labels}`;
      els.meta.title = els.meta.title ? `${els.meta.title}\n${focusTitle}` : focusTitle;
    }
  }
  if (meta.critique) {
    if (Number.isFinite(meta.critique.score)) {
      bits.push(`评审 ${meta.critique.score}${meta.critique.repaired ? "*" : ""}`);
    } else if (meta.critique.error) {
      bits.push("评审不可用");
    }
    if (Array.isArray(meta.critique.issues) && meta.critique.issues.length) {
      els.meta.title = meta.critique.issues
        .map((item) => `[${item.severity}] ${item.message}${item.fix ? ` → ${item.fix}` : ""}`)
        .join("\n");
    }
  }
  if (Number.isFinite(meta.ms)) bits.push(formatSeconds(meta.ms));
  if (meta.usage && meta.usage.total_tokens) {
    const reasoning = meta.usage.reasoning_tokens;
    bits.push(`${meta.usage.total_tokens} tokens${reasoning ? ` · 推理 ${reasoning}` : ""}`);
  }
  if (meta.cost && Number.isFinite(meta.cost.total)) {
    const estimate = formatUSD(meta.cost.total);
    bits.push(estimate.startsWith("<") ? estimate : `≈${estimate}`);
    const parts = [];
    if (meta.cost.inputTokens) {
      parts.push(`输入 ${meta.cost.inputTokens} tok ${formatUSD(meta.cost.input)}`);
    }
    if (meta.cost.outputTokens) {
      parts.push(`输出 ${meta.cost.outputTokens} tok ${formatUSD(meta.cost.output)}`);
    }
    const costTitle = `成本按 .env 单价估算：${parts.join(" + ") || "无 token 消耗"}`;
    els.meta.title = els.meta.title ? `${els.meta.title}\n${costTitle}` : costTitle;
  }
  if (meta.cached) bits.push("缓存");
  els.meta.textContent = bits.join(" · ");

  if (meta.warning) {
    els.hint.textContent = meta.warning;
    els.hint.classList.add("warn");
  } else {
    els.hint.classList.remove("warn");
    els.hint.textContent = (isReference
      ? (meta.mode === "llm" ? state.referenceHint : state.referenceLocalHint)
      : (meta.mode === "llm" ? state.baseHint : state.localHint))
      || "已生成。计划 JSON 可展开查看或复制。";
  }

  els.plan.textContent = JSON.stringify(data.plan, null, 2);
  els.planSize.textContent = `${(JSON.stringify(data.plan).length / 1024).toFixed(1)} KB`;
  if (pending) {
    els.download.disabled = true;
    els.downloadPng.disabled = true;
    els.actions.hidden = true;
    return;
  }
  els.download.disabled = false;
  els.downloadPng.disabled = false;
  els.actions.hidden = false;
  state.last = {
    svg: data.svg,
    plan: data.plan,
    meta,
    prompt,
    referenceKey: state.reference ? state.reference.key : "",
    reference: isReference,
    style: state.style,
    mode: els.mode.value,
    stylePack: state.stylePack,
    paintStyle: meta.paintStyle || state.paintStyle,
    brush: meta.brush ?? state.brush,
    detail: Boolean(meta.detail && meta.detail.requested) || state.detail,
  };
}

function logComposition(plan, meta, prompt) {
  if (!plan || !Array.isArray(plan.layers)) return;
  const layers = plan.layers;
  const total = layers.reduce(
    (sum, layer) => sum + (Array.isArray(layer.elements) ? layer.elements.length : 0),
    0
  );
  const mode = meta.mode === "llm" ? `LLM${meta.model ? ` · ${meta.model}` : ""}` : "本地规则";
  const variant = meta.variant ? ` · 变体 ${meta.variant}` : "";
  console.groupCollapsed(
    `[lmbrush] 构图 · ${mode}${variant} · ${plan.canvas.w}×${plan.canvas.h} · ${layers.length} 层 / ${total} 图元`
  );
  console.log("prompt:", prompt);
  if (plan.concept) console.log("concept:", plan.concept);
  layers.forEach((layer, index) => {
    const elements = Array.isArray(layer.elements) ? layer.elements : [];
    const counts = new Map();
    for (const element of elements) {
      counts.set(element.type, (counts.get(element.type) || 0) + 1);
    }
    console.log(
      `${index + 1}. ${layer.id} (${elements.length})`,
      [...counts.entries()].map(([type, count]) => `${type}×${count}`).join(" ")
    );
  });
  console.log("plan:", plan);
  console.groupEnd();
}

function showError(message) {
  els.stage.innerHTML = "";
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = message;
  els.stage.append(box);
  els.meta.textContent = "生成失败";
  els.hint.textContent = message;
  els.hint.classList.add("warn");
  els.actions.hidden = true;
}

function download() {
  if (state.busy || !state.last) return;
  const blob = new Blob([state.last.svg], { type: "image/svg+xml;charset=utf-8" });
  saveBlob(blob, `${slug(state.last.plan.title || state.last.prompt)}.svg`);
}

async function downloadPng() {
  if (state.busy || !state.last) return;
  const { svg, plan } = state.last;
  const width = plan.canvas.w || 1000;
  const height = plan.canvas.h || 1000;
  const source = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("PNG 导出失败"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG 导出失败");
    saveBlob(blob, `${slug(plan.title || state.last.prompt)}.png`);
  } catch (error) {
    els.meta.textContent = error.message;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return seconds < 1 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
}

function formatUSD(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "$0";
  if (amount < 0.000001) return "<$0.000001";
  const digits = amount < 0.01 ? 6 : amount < 1 ? 4 : 2;
  return `$${amount.toFixed(digits)}`;
}

function brushLabel(value) {
  const scale = Number(value) || 1;
  if (scale < 0.36) return "纤毫";
  if (scale < 0.6) return "极细";
  if (scale < 0.9) return "细腻";
  if (scale > 1.2) return "粗犷";
  return "标准";
}

function slug(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return cleaned || "lmbrush";
}

function isSafeSvg(svg) {
  return (
    typeof svg === "string" &&
    svg.startsWith("<svg") &&
    !/<script|on[a-z]+\s*=|javascript:|<foreignObject|href\s*=\s*["']https?:/i.test(svg)
  );
}

/* ------------------------------------------------------------------ history */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item) => item && typeof item.svg === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(data, prompt) {
  const variant = data.meta && Number.isFinite(data.meta.variant) ? data.meta.variant : 0;
  const referenceKey = state.reference ? state.reference.key : "";
  const title = data.plan.title || prompt || "参考图重绘";
  const list = loadHistory().filter((item) => {
    const itemVariant = item.meta && Number.isFinite(item.meta.variant) ? item.meta.variant : 0;
    return !(item.prompt === prompt
      && itemVariant === variant
      && (item.referenceKey || "") === referenceKey);
  });
  list.unshift({
    id: Date.now(),
    prompt,
    title,
    reference: Boolean(state.reference),
    referenceKey,
    style: state.style,
    paintStyle: state.paintStyle,
    brush: state.brush,
    detail: state.detail,
    svg: data.svg,
    plan: data.plan,
    meta: data.meta,
  });
  const trimmed = list.slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage full: history is best-effort */
  }
  renderHistory(trimmed);
}

function renderHistory(list) {
  els.history.innerHTML = "";
  for (const item of list) {
    if (!isSafeSvg(item.svg)) continue;
    const button = document.createElement("button");
    button.type = "button";
    const label = item.title || item.prompt || "参考图重绘";
    button.title = label;
    button.setAttribute("aria-label", `恢复历史画面：${label}`);
    button.innerHTML = item.svg;
    button.addEventListener("click", () => restore(item));
    els.history.append(button);
  }
}

function restore(item) {
  if (state.busy || state.referenceBusy) return;
  els.prompt.value = item.prompt;
  state.sourcePrompt = item.prompt;
  state.enriched = false;
  state.variant = item.meta && Number.isFinite(item.meta.variant) ? item.meta.variant : 0;
  syncVariant();
  els.stage.innerHTML = item.svg;
  els.plan.textContent = JSON.stringify(item.plan, null, 2);
  els.planSize.textContent = `${(JSON.stringify(item.plan).length / 1024).toFixed(1)} KB`;
  els.meta.textContent = "历史记录";
  els.hint.classList.remove("warn");
  els.hint.textContent = item.reference
    ? "已恢复历史画面。参考图本身不会存进历史记录；重新上传后才能再次重绘。"
    : "已恢复历史画面。可以直接再生成，或展开绘制计划查看内容。";
  els.download.disabled = false;
  els.downloadPng.disabled = false;
  els.actions.hidden = false;
  if (item.paintStyle) {
    state.paintStyle = item.paintStyle;
    const button = [...els.paintStyleGroup.querySelectorAll("button")]
      .find((candidate) => candidate.dataset.paintStyle === item.paintStyle);
    if (button) markPressed(els.paintStyleGroup, button);
  }
  if (item.brush) {
    state.brush = item.brush;
    const button = [...els.brushGroup.querySelectorAll("button")]
      .find((candidate) => Number(candidate.dataset.brush) === item.brush);
    if (button) markPressed(els.brushGroup, button);
  }
  state.detail = Boolean(item.detail);
  els.detailToggle.checked = state.detail;
  syncDetailToggle();
  if (item.style) {
    state.style = item.style;
    const button = [...els.styleGroup.querySelectorAll("button")]
      .find((candidate) => candidate.dataset.style === item.style);
    if (button) markPressed(els.styleGroup, button);
  }
  state.last = {
    svg: item.svg,
    plan: item.plan,
    meta: item.meta || {},
    prompt: item.prompt,
    referenceKey: state.reference ? state.reference.key : "",
    reference: Boolean(item.reference),
    style: state.style,
    mode: els.mode.value,
    stylePack: state.stylePack,
    paintStyle: state.paintStyle,
    brush: state.brush,
    detail: state.detail,
  };
}