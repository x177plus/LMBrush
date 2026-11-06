/* Plan → PNG preview for the vision critic.
 *
 * This is the same software-rasterized color guide used by the painterly
 * renderer, encoded as a real PNG so multimodal models can read it. It shows
 * composition, silhouette and color, not brush texture.
 */

import { rasterizePlan } from "./raster.js";
import { encodePngRgb } from "./png.js";

export function renderPreviewPng(plan, { size = 384 } = {}) {
  const guide = rasterizePlan(plan, { size, supersample: 2 });
  const { width, height, data } = guide;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i++) {
    const value = data[i];
    rgb[i] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
  }
  return {
    png: encodePngRgb(width, height, rgb),
    width,
    height,
  };
}