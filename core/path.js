/* Strict structural validator for SVG path data produced by an LLM.
 * Only geometry commands are allowed; anything else (style, URLs, scripts)
 * is rejected before the path ever reaches the renderer.
 */

const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const SEPARATOR = /[\s,]/;

export function validatePathData(d, opts = {}) {
  const {
    maxLength = 3000,
    maxCommands = 400,
    min = -500,
    max = 1500,
  } = opts;

  if (typeof d !== "string") return fail("path 必须是字符串");
  const src = d.trim();
  if (!src) return fail("path 为空");
  if (src.length > maxLength) return fail(`path 过长（${src.length} > ${maxLength}）`);

  let i = 0;
  let commands = 0;
  let sawCommand = false;

  while (i < src.length) {
    while (i < src.length && SEPARATOR.test(src[i])) i++;
    if (i >= src.length) break;

    const letter = src[i];
    if (!/[A-Za-z]/.test(letter)) return fail(`位置 ${i} 处缺少命令`);
    const command = letter.toUpperCase();
    if (!(command in ARITY)) return fail(`不支持的命令 "${letter}"`);
    if (!sawCommand && command !== "M") return fail("path 必须以 M 开头");
    sawCommand = true;
    i++;
    commands++;
    if (commands > maxCommands) return fail("path 命令过多");

    const arity = ARITY[command];
    if (arity === 0) continue;

    let count = 0;
    for (;;) {
      while (i < src.length && SEPARATOR.test(src[i])) i++;
      if (i >= src.length) break;
      if (/[A-Za-z]/.test(src[i])) break;

      const match = src.slice(i).match(NUMBER);
      if (!match) return fail(`位置 ${i} 处数字无效`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) return fail(`位置 ${i} 处数字无效`);
      if (value < min || value > max) {
        return fail(`坐标 ${match[0]} 超出允许范围 [${min}, ${max}]`);
      }
      count++;
      if (command === "A" && (count % 7 === 4 || count % 7 === 5)) {
        if (value !== 0 && value !== 1) return fail("arc 标志位必须是 0 或 1");
      }
      i += match[0].length;
    }

    if (count === 0) return fail(`命令 ${letter} 缺少参数`);
    if (count % arity !== 0) {
      return fail(`命令 ${letter} 参数数量错误（需要 ${arity} 的整数倍，得到 ${count}）`);
    }
  }

  if (!sawCommand) return fail("path 为空");
  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}