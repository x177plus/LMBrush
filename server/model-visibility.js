/* Model-name visibility.
 *
 * Vercel deployments hide model names by default (VERCEL=1); local and
 * self-hosted copies from GitHub show them. HIDE_MODEL=1 forces hiding in any
 * environment, HIDE_MODEL=0 forces showing on Vercel. Redaction happens in the
 * JSON response, so the name is absent from both the page and the network
 * payload. Server logs and upstream requests are untouched.
 */

export function hideModelName() {
  const value = String(process.env.HIDE_MODEL ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  return process.env.VERCEL === "1";
}

function hiddenNames() {
  const names = [process.env.LLM_MODEL, process.env.VISION_MODEL]
    .map((name) => String(name || "").trim())
    .filter((name) => name.length >= 4);
  // Longest first so overlapping ids cannot leave a suffix behind.
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

/* Copy-on-change: only objects on a path to a redacted value are cloned, so
 * cached plans and 3 MB SVG strings are shared rather than duplicated. */
export function redactModelNames(value) {
  if (!hideModelName()) return value;
  return redactValue(value, hiddenNames());
}

function redactValue(value, names) {
  if (typeof value === "string") {
    let next = value;
    for (const name of names) {
      if (next.includes(name)) next = next.split(name).join("hidden");
    }
    return next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = redactValue(item, names);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "model") {
        copy[key] = null;
        changed = true;
        continue;
      }
      const next = redactValue(child, names);
      copy[key] = next;
      if (next !== child) changed = true;
    }
    return changed ? copy : value;
  }
  return value;
}