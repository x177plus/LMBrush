/* Flatten SVG path data into polylines for the software rasterizer.
 * The validator already guarantees syntactically valid data; this module
 * only needs to produce geometry, and is tolerant of odd input.
 */

const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export function flattenPathData(d, options = {}) {
  const { cubicSteps = 12, quadSteps = 10, arcSteps = 24 } = options;
  const commands = expand(tokenize(d));
  const subpaths = [];

  let current = [0, 0];
  let start = [0, 0];
  let sub = null;
  let needsNewSub = false;
  let previous = null;

  const begin = (point) => {
    sub = { points: [[point[0], point[1]]], closed: false };
    subpaths.push(sub);
    needsNewSub = false;
  };
  const add = (point) => {
    if (!sub) begin(current);
    sub.points.push([point[0], point[1]]);
  };

  for (const { cmd, params } of commands) {
    const upper = cmd.toUpperCase();
    const relative = cmd !== upper;
    const ox = relative ? current[0] : 0;
    const oy = relative ? current[1] : 0;

    if (upper === "M") {
      const point = [params[0] + ox, params[1] + oy];
      current = point;
      start = point.slice();
      begin(point);
      previous = { cmd: "M" };
      continue;
    }

    if (!sub || needsNewSub) begin(current);

    if (upper === "Z") {
      if (sub) sub.closed = true;
      current = start.slice();
      needsNewSub = true;
      previous = { cmd: "Z" };
      continue;
    }

    if (upper === "L") {
      const point = [params[0] + ox, params[1] + oy];
      add(point);
      current = point;
      previous = { cmd: "L" };
    } else if (upper === "H") {
      const point = [params[0] + ox, current[1]];
      add(point);
      current = point;
      previous = { cmd: "H" };
    } else if (upper === "V") {
      const point = [current[0], params[0] + oy];
      add(point);
      current = point;
      previous = { cmd: "V" };
    } else if (upper === "C") {
      const c1 = [params[0] + ox, params[1] + oy];
      const c2 = [params[2] + ox, params[3] + oy];
      const end = [params[4] + ox, params[5] + oy];
      for (const point of cubic(current, c1, c2, end, cubicSteps)) add(point);
      current = end;
      previous = { cmd: "C", cubic: c2 };
    } else if (upper === "S") {
      const c1 = previous && (previous.cmd === "C" || previous.cmd === "S") && previous.cubic
        ? [2 * current[0] - previous.cubic[0], 2 * current[1] - previous.cubic[1]]
        : current.slice();
      const c2 = [params[0] + ox, params[1] + oy];
      const end = [params[2] + ox, params[3] + oy];
      for (const point of cubic(current, c1, c2, end, cubicSteps)) add(point);
      current = end;
      previous = { cmd: "S", cubic: c2 };
    } else if (upper === "Q") {
      const control = [params[0] + ox, params[1] + oy];
      const end = [params[2] + ox, params[3] + oy];
      for (const point of quadratic(current, control, end, quadSteps)) add(point);
      current = end;
      previous = { cmd: "Q", quad: control };
    } else if (upper === "T") {
      const control = previous && (previous.cmd === "Q" || previous.cmd === "T") && previous.quad
        ? [2 * current[0] - previous.quad[0], 2 * current[1] - previous.quad[1]]
        : current.slice();
      const end = [params[0] + ox, params[1] + oy];
      for (const point of quadratic(current, control, end, quadSteps)) add(point);
      current = end;
      previous = { cmd: "T", quad: control };
    } else if (upper === "A") {
      const end = [params[5] + ox, params[6] + oy];
      const points = arc(current, params[0], params[1], params[2], params[3], params[4], end, arcSteps);
      for (const point of points) add(point);
      current = end;
      previous = { cmd: "A" };
    }
  }

  return subpaths;
}

function tokenize(d) {
  const groups = [];
  let current = null;
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      current = { cmd: ch, params: [] };
      groups.push(current);
      i++;
      continue;
    }
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!match) {
      i++;
      continue;
    }
    if (current) current.params.push(Number(match[0]));
    i += match[0].length;
  }
  return groups;
}

function expand(groups) {
  const out = [];
  for (const { cmd, params } of groups) {
    const upper = cmd.toUpperCase();
    const arity = ARITY[upper];
    if (arity === 0) {
      out.push({ cmd, params: [] });
      continue;
    }
    if (params.length < arity) continue;
    for (let k = 0; k + arity <= params.length; k += arity) {
      let next = cmd;
      if (upper === "M" && k > 0) next = cmd === "M" ? "L" : "l";
      out.push({ cmd: next, params: params.slice(k, k + arity) });
    }
  }
  return out;
}

function cubic(p0, p1, p2, p3, steps) {
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

function quadratic(p0, p1, p2, steps) {
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return points;
}

function arc(start, rx, ry, rotationDeg, largeArc, sweep, end, steps) {
  if (!rx || !ry) return [end];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = ((rotationDeg % 360) * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);

  const dx = (start[0] - end[0]) / 2;
  const dy = (start[1] - end[1]) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));

  const cxp = coefficient * ((rx * y1p) / ry);
  const cyp = coefficient * ((-ry * x1p) / rx);
  const cx = cos * cxp - sin * cyp + (start[0] + end[0]) / 2;
  const cy = sin * cxp + cos * cyp + (start[1] + end[1]) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  const theta1 = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const points = [];
  for (let i = 1; i <= steps; i++) {
    const angle = theta1 + delta * (i / steps);
    points.push([
      cx + cos * rx * Math.cos(angle) - sin * ry * Math.sin(angle),
      cy + sin * rx * Math.cos(angle) + cos * ry * Math.sin(angle),
    ]);
  }
  return points;
}