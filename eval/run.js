/* Batch evaluation: runs the pipeline over eval/prompts.jsonl and reports
 * validity, latency, and scene complexity. Usage:
 *   node eval/run.js            # local rules
 *   node eval/run.js --llm      # requires LLM_* env vars
 */

import { readFile, writeFile } from "node:fs/promises";
import { generate, clearCache } from "../server/generate.js";
import { llmConfig } from "../server/llm.js";

const useLLM = process.argv.includes("--llm");
const useBlockin = process.argv.includes("--blockin");
const usePaint = process.argv.includes("--paint") || useBlockin;
const paintStyle = useBlockin ? "blockin" : "classic";
const mode = useLLM ? "llm" : "local";
const render = usePaint ? "paint" : "flat";

if (useLLM) {
  const cfg = llmConfig();
  if (!cfg.configured) {
    console.error("LLM 未配置。设置 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY，或去掉 --llm。");
    process.exit(1);
  }
  console.log(`LLM 模式：${cfg.model}`);
} else {
  process.env.LLM_DISABLE = "1";
  console.log("本地规则模式");
}

console.log(useBlockin ? "色块铺陈模式" : usePaint ? "经典油画笔触模式" : "扁平矢量模式");

const lines = (await readFile(new URL("./prompts.jsonl", import.meta.url), "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

clearCache();
const results = [];
const startedAt = Date.now();

for (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    console.warn(`跳过无效行：${line}`);
    continue;
  }

  const started = performance.now();
  try {
    const result = await generate({
      prompt: entry.prompt,
      style: entry.style || "auto",
      mode,
      render,
      paintStyle,
    });
    const ms = Math.round(performance.now() - started);
    const elements = result.plan.layers.reduce((sum, layer) => sum + layer.elements.length, 0);
    results.push({
      prompt: entry.prompt,
      ok: true,
      ms,
      mode: result.meta.mode,
      title: result.plan.title,
      layers: result.plan.layers.length,
      elements,
      strokes: result.meta.strokes || null,
      bytes: Buffer.byteLength(result.svg),
    });
    console.log(`✓ ${ms.toString().padStart(5)}ms  ${elements.toString().padStart(3)} el  ${entry.prompt}`);
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    results.push({
      prompt: entry.prompt,
      ok: false,
      ms,
      error: error.message,
      details: error.details || null,
    });
    console.log(`✗ ${ms.toString().padStart(5)}ms  ${entry.prompt}  →  ${error.message}`);
  }
}

const ok = results.filter((item) => item.ok);
const latencies = ok.map((item) => item.ms).sort((a, b) => a - b);
const summary = {
  mode,
  render,
  paintStyle: usePaint ? paintStyle : null,
  total: results.length,
  ok: ok.length,
  failed: results.length - ok.length,
  validityRate: results.length ? Number((ok.length / results.length).toFixed(4)) : 0,
  avgMs: ok.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / ok.length) : 0,
  p95Ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0,
  avgElements: ok.length ? Math.round(ok.reduce((a, b) => a + b.elements, 0) / ok.length) : 0,
  avgStrokes: ok.length ? Math.round(ok.reduce((a, b) => a + (b.strokes || 0), 0) / ok.length) : 0,
  avgBytes: ok.length ? Math.round(ok.reduce((a, b) => a + b.bytes, 0) / ok.length) : 0,
  wallMs: Date.now() - startedAt,
};

const report = { generatedAt: new Date().toISOString(), summary, results };
const out = new URL("./report.json", import.meta.url);
await writeFile(out, JSON.stringify(report, null, 2));

console.log("\n" + "─".repeat(52));
console.log(`有效 ${summary.ok}/${summary.total}（${(summary.validityRate * 100).toFixed(1)}%）`);
console.log(`平均 ${summary.avgMs}ms · P95 ${summary.p95Ms}ms · 平均 ${summary.avgElements} 个图元`);
if (summary.avgStrokes) console.log(`平均 ${summary.avgStrokes} 笔 · 平均 ${Math.round(summary.avgBytes / 1024)} KB`);
console.log(`报告：eval/report.json`);