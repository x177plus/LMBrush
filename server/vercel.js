/* Vercel Functions adapter.
 *
 * Vercel does not run a long-lived `node server.js` process. Each route in
 * `api/` imports this module and forwards the Node request/response pair to
 * the same HTTP handler used by the local server.
 */
import { createApp } from "../server.js";

const app = createApp();

export default function handler(req, res) {
  app.emit("request", req, res);
}