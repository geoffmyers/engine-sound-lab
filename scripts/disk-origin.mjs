// Serve the working copy to a browser context without a server: every request to ORIGIN is
// answered from the files on disk. A remote GPU browser (a neko room over CDP) can then load the
// page even though it cannot reach this host. A worklet's module fetch bypasses request routing,
// so the page is made to use its ScriptProcessor fallback instead.
import { readFile } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ORIGIN = "https://engine-sound-lab.preview";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".css": "text/css", ".png": "image/png" };

export async function serveFromDisk(ctx) {
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    let path = new URL(route.request().url()).pathname;
    if (path.endsWith("/")) path += "index.html";
    try {
      const body = await readFile(join(root, decodeURIComponent(path)));
      await route.fulfill({ status: 200, body, contentType: TYPES[extname(path)] || "application/octet-stream" });
    } catch { await route.fulfill({ status: 404, body: "not found" }); }
  });
  await ctx.addInitScript(() => Object.defineProperty(BaseAudioContext.prototype, "audioWorklet", { get: () => undefined }));
  return `${ORIGIN}/`;
}
