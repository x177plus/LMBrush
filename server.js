/* Minimal HTTP server: static page + one generation endpoint.
 * No framework, no build step, Node >= 20.6.
 */

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generate, GenerationError } from "./server/generate.js";
import { runPipelineStep } from "./server/pipeline.js";
import { enrichPrompt, EnrichError } from "./server/enrich.js";
import { repaintReference, RepaintError } from "./server/reference.js";
import { llmConfig } from "./server/llm.js";
import { listStylePacks } from "./server/style-packs.js";
import { visionConfig } from "./server/vision.js";
import { redactModelNames } from "./server/model-visibility.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const STATIC = new Map([
  ["/", { file: "public/index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "public/index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "public/styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "public/app.js", type: "text/javascript; charset=utf-8" }],
  ["/image-size.js", { file: "public/image-size.js", type: "text/javascript; charset=utf-8" }],
]);

const json = (res, status, body) => {
  const data = JSON.stringify(redactModelNames(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
};

/* Optional demo gate. Set DEMO_TOKEN to require a password on POST /api/*;
 * leave it empty for a fully public deployment. The browser gets the cookie
 * from /api/login?token=…, while scripts can send Authorization or x-demo-token.
 */
const AUTH_COOKIE = "lmbrush_token";

function demoToken() {
  return String(process.env.DEMO_TOKEN || "").trim();
}

function sameToken(a, b) {
  const left = createHash("sha256").update(String(a ?? "")).digest();
  const right = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(left, right);
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function requestToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const direct = req.headers["x-demo-token"];
  if (direct) return String(direct).trim();
  return readCookie(req, AUTH_COOKIE);
}

function isAuthorized(req) {
  const expected = demoToken();
  if (!expected) return true;
  const provided = requestToken(req);
  return Boolean(provided) && sameToken(provided, expected);
}

function safeNext(value) {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function login(res, req, url) {
  const expected = demoToken();
  const next = safeNext(url.searchParams.get("next"));
  if (!expected) {
    res.writeHead(302, { location: next, "cache-control": "no-store" });
    return res.end();
  }
  if (!sameToken(url.searchParams.get("token"), expected)) {
    return json(res, 401, { ok: false, code: "UNAUTHORIZED", error: "访问口令不正确" });
  }
  const secure = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"
    ? "; Secure"
    : "";
  res.writeHead(302, {
    location: next,
    "set-cookie": `${AUTH_COOKIE}=${encodeURIComponent(expected)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
    "cache-control": "no-store",
  });
  res.end();
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/api/login") {
        return login(res, req, url);
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        const cfg = llmConfig();
        const vision = visionConfig();
        return json(res, 200, {
          ok: true,
          auth: { required: Boolean(demoToken()), authenticated: isAuthorized(req) },
          llm: { configured: cfg.configured, model: cfg.configured ? cfg.model : null },
          vision: { configured: vision.configured, model: vision.configured ? vision.model : null },
          stylePacks: listStylePacks(),
          node: process.version,
        });
      }

      if (req.method === "POST" && !isAuthorized(req)) {
        return json(res, 401, {
          ok: false,
          code: "UNAUTHORIZED",
          error: "需要访问口令：用 /api/login?token=… 打开一次后再试",
        });
      }

      if (req.method === "POST" && url.pathname === "/api/enrich") {
        const body = await readJson(req);
        const result = await enrichPrompt(body.prompt, {
          nonce: body.nonce ?? Date.now(),
          deadline: Date.now() + 280000,
        });
        return json(res, 200, { ok: true, ...result });
      }

      if (req.method === "POST" && url.pathname === "/api/repaint") {
        // Raw RGB for a 768px image is ~1.7 MB; base64 plus JSON needs ~2.4 MB.
        const body = await readJson(req, 4 * 1024 * 1024);
        const result = await repaintReference({
          image: body.image,
          prompt: body.prompt,
          mode: body.mode || "auto",
          paintStyle: body.paintStyle || "classic",
          brush: body.brush ?? 1,
          variant: body.variant ?? 0,
        });
        return json(res, 200, { ok: true, ...result });
      }

      if (req.method === "POST" && url.pathname === "/api/pipeline") {
        // The browser holds the plan between steps, so accept a larger body
        // than the prompt-only endpoints.
        const body = await readJson(req, 1024 * 1024);
        const result = await runPipelineStep(body);
        return json(res, 200, { ok: true, step: body.step, ...result });
      }

      if (req.method === "POST" && url.pathname === "/api/generate") {
        const body = await readJson(req);
        const result = await generate({
          prompt: body.prompt,
          style: body.style || "auto",
          mode: body.mode || "auto",
          render: body.render || "paint",
          paintStyle: body.paintStyle || "classic",
          brush: body.brush ?? 1,
          variant: body.variant ?? 0,
          stylePack: body.stylePack || "",
          detail: body.detail ?? false,
        });
        return json(res, 200, { ok: true, ...result });
      }

      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }

      const asset = STATIC.get(url.pathname);
      if (req.method === "GET" && asset) {
        const content = await readFile(path.join(ROOT, asset.file));
        res.writeHead(200, {
          "content-type": asset.type,
          "content-length": content.length,
          "cache-control": asset.cache || "no-cache",
        });
        return res.end(content);
      }

      if (url.pathname.startsWith("/api/")) return json(res, 404, { ok: false, error: "接口不存在" });
      return json(res, 404, { ok: false, error: "页面不存在" });
    } catch (error) {
      if (error instanceof EnrichError) {
        return json(res, error.status, { ok: false, error: error.message });
      }
      if (error instanceof GenerationError) {
        return json(res, error.status, { ok: false, error: error.message, details: error.details });
      }
      if (error instanceof RepaintError) {
        return json(res, error.status, { ok: false, error: error.message, details: error.details });
      }
      if (error && error.code === "BODY_TOO_LARGE") {
        return json(res, 413, { ok: false, error: "请求体过大" });
      }
      console.error("[server]", error);
      return json(res, 500, { ok: false, error: "服务器内部错误" });
    }
  });
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GenerationError("请求体必须是合法 JSON", 400);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.PORT) || 5174;
  const host = process.env.HOST || "127.0.0.1";
  const server = createApp();
  server.listen(port, host, () => {
    const cfg = llmConfig();
    const vision = visionConfig();
    const reasoning = cfg.reasoningEffort
      || (cfg.extraBody && cfg.extraBody.reasoning_effort)
      || "default";
    console.log(`LMBrush 运行中  http://${host}:${port}`);
    console.log(`LLM: ${cfg.configured ? `已配置（${cfg.model} · reasoning=${reasoning}）` : "未配置，使用本地规则模式"}`);
    console.log(
      `Vision: ${vision.configured
        ? `${vision.model} · reasoning=${vision.reasoningEffort || "default"} · maxRepairs=${vision.maxRepairs}`
        : "关闭"}`
    );
  });
}