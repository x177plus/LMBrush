/* Test files mock every model call. Clear LLM/VISION settings inherited from
 * the caller's shell so a developer's .env-style environment cannot change
 * defaults such as LLM_MAX_TOKENS and make tests order-dependent.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LLM_") || key.startsWith("VISION_")) delete process.env[key];
  if (key === "DEMO_TOKEN" || key === "VERCEL" || key === "HIDE_MODEL") delete process.env[key];
}