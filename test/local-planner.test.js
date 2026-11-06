import test from "node:test";
import assert from "node:assert/strict";
import { planFromPrompt } from "../core/local-planner.js";
import { normalizePlan, validatePlan } from "../core/schema.js";
import { renderPlan } from "../core/render.js";

const PROMPTS = [
  "戴圆眼镜的短发女孩，暖色调，扁平插画风",
  "一只橘猫坐在窗台上，窗外是夜空",
  "一只柴犬的肖像，线稿描边",
  "晨雾中的山谷，远山和松树",
  "海边的帆船，日落",
  "森林里的小木屋，渐变光",
  "城市夜景，霓虹",
  "宇航员站在星球上",
  "一束郁金香，柔和粉色调",
  "抽象构成，几何色块",
  "一只狐狸，极简风格",
  "一只兔子",
  "一只鸟",
  "一条鱼",
  "一只熊猫",
];

test("local planner produces valid plans for every subject family", () => {
  for (const prompt of PROMPTS) {
    const plan = normalizePlan(planFromPrompt(prompt));
    const check = validatePlan(plan);
    assert.deepEqual(check.errors, [], `${prompt} -> ${check.errors.join("; ")}`);
    const svg = renderPlan(plan);
    assert.ok(svg.startsWith("<svg"), prompt);
    assert.ok(svg.includes("</svg>"), prompt);
  }
});

test("local planner is deterministic", () => {
  const a = renderPlan(planFromPrompt("一只橘猫"));
  const b = renderPlan(planFromPrompt("一只橘猫"));
  assert.equal(a, b);
});

test("local planner variant changes details deterministically", () => {
  const first = renderPlan(planFromPrompt("星空", "flat", 3));
  const repeat = renderPlan(planFromPrompt("星空", "flat", 3));
  const next = renderPlan(planFromPrompt("星空", "flat", 4));
  assert.equal(first, repeat);
  assert.notEqual(first, next);
});

test("local planner respects an explicit style override", () => {
  const plan = normalizePlan(planFromPrompt("一只猫", "line"));
  assert.equal(plan.style.preset, "line");
  assert.match(plan.style.outline, /^#[0-9a-f]{6}$/i);
});

test("local planner handles empty input without throwing", () => {
  const plan = normalizePlan(planFromPrompt(""));
  assert.equal(validatePlan(plan).ok, true);
});